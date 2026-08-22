import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { agentError } from "./agent/agent-protocol.mjs";
import { createClaudePermissionBridge } from "./claude-permission-bridge.mjs";

const execFile = promisify(execFileCallback);
const MINIMUM_VERSION = "2.1.214";
// interactive profile(claude-on-request)がCLIへ渡すpermission-prompt-tool。
// shimはtools/list上でこの完全修飾名(mcp__<server>__<tool>)として現れる。
const CLAUDE_PERMISSION_TOOL_NAME = "mcp__bitty_permission__approval_prompt";
const CLAUDE_PERMISSION_SHIM_PATH = fileURLToPath(new URL("../tools/claude-permission-prompt-mcp.mjs", import.meta.url));
// interactive時のみ設定するCLI側MCPタイムアウト。承認待ちは無期限になり得るため、
// turnTimeoutと同桁の大きな値でclient側タイムアウトを無効化する(§4.5)。
const CLAUDE_PERMISSION_MCP_TIMEOUT_MS = String(24 * 60 * 60 * 1000);
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_MODELS = [
  { modelId: "haiku", label: "Claude Haiku" },
  { modelId: "sonnet", label: "Claude Sonnet" },
  { modelId: "opus", label: "Claude Opus" },
  { modelId: "fable", label: "Claude Fable" },
];
const MODEL_ALIASES = new Set(CLAUDE_MODELS.map((model) => model.modelId));

// フルmodel id("claude-haiku-4-5-20251001"等)をカタログのalias("haiku"等)へ寄せる
function modelAliasOf(modelIdRaw) {
  const modelId = String(modelIdRaw || "").trim().toLowerCase();
  if (MODEL_ALIASES.has(modelId)) return modelId;
  for (const alias of MODEL_ALIASES) if (modelId.includes(alias)) return alias;
  return "";
}
// Claude CLI `--effort` が受け付ける値。`ultra`はCLI helpに存在しないため含めない。
const CLAUDE_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

function versionTuple(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function isClaudeVersionSupported(version, minimum = MINIMUM_VERSION) {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function safeEnvironment(source) {
  const exact = new Set([
    "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "TERM", "COLORTERM",
    "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ]);
  const target = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (exact.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) target[key] = value;
  }
  return target;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function processIdentity(runFile, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const result = await runFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000, encoding: "utf8" });
    const startedAt = String(typeof result === "string" ? result : result?.stdout || "").trim();
    return startedAt ? JSON.stringify({ pid, startedAt }) : "";
  } catch {
    return "";
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// Claude CLIがトランスクリプトへ注入するシステム由来メッセージ。ユーザー発話では
// ないため、履歴表示では折りたたみ対象(internal_context)として返す。
const INTERNAL_CONTEXT_TAG_PATTERN = /^<(system-reminder|recommended_plugins|command-name|command-message|command-args|command-contents|local-command-caveat|local-command-stdout|local-command-stderr|task-notification)\b/;

function classifyHistoryItemType(record, text) {
  if (record?.isSidechain === true) return "sidechain";
  if (record?.isMeta === true) return "internal_context";
  // /compactの要約はシステム生成。折りたたみ表示にする。
  if (record?.isCompactSummary === true) return "internal_context";
  if (String(record?.type || "") === "user" && INTERNAL_CONTEXT_TAG_PATTERN.test(String(text || "").trimStart())) {
    return "internal_context";
  }
  return "";
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cursorDecode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isClaudeAuthFailure(...values) {
  return /not logged in|login required|authentication|oauth|unauthorized/i.test(values.map(String).join("\n"));
}

function claudeResultDiagnostic(result) {
  try { return JSON.stringify(result).slice(0, MAX_STDERR_BYTES); } catch { return ""; }
}

export function createClaudeBackend({
  binary = "claude",
  minimumVersion = MINIMUM_VERSION,
  environment = process.env,
  homeDirectory = os.homedir(),
  projectsRoot = path.join(homeDirectory, ".claude", "projects"),
  fileSystem = fs,
  spawnProcess = spawn,
  runFile = execFile,
  sessionStore,
  modelInfoStore = null,
  noOutputTimeoutMs = 5 * 60 * 1000,
  turnTimeoutMs = 24 * 60 * 60 * 1000,
  compactTimeoutMs = 10 * 60 * 1000,
  interruptGraceMs = 1500,
  generateSessionId = randomUUID,
} = {}) {
  if (typeof sessionStore?.getBinding !== "function") throw new TypeError("sessionStore.getBinding is required");
  const activeRuns = new Map();
  let probePromise = null;

  async function probe() {
    let binaryPath = "";
    let version = "";
    try {
      if (path.isAbsolute(binary) || binary.includes(path.sep)) binaryPath = await fileSystem.realpath(binary);
      else {
        const found = await runFile("which", [binary], { timeout: 5000, encoding: "utf8" });
        const stdout = typeof found === "string" ? found : found?.stdout;
        binaryPath = await fileSystem.realpath(String(stdout || "").trim().split(/\r?\n/, 1)[0]);
      }
      const result = await runFile(binaryPath, ["--version"], { timeout: 5000, encoding: "utf8" });
      version = String(typeof result === "string" ? result : result?.stdout || "").trim();
    } catch {
      return { binaryPath: "", version: "", supported: false };
    }
    return { binaryPath, version, supported: isClaudeVersionSupported(version, minimumVersion) };
  }

  async function runtime() {
    if (!probePromise) probePromise = probe();
    const detected = await probePromise;
    if (!detected.supported) probePromise = null;
    return detected;
  }

  async function getStatus() {
    return {
      backendId: "claude",
      available: true,
      auth: { state: "unknown" },
      readiness: { ready: true },
      capabilities: {
        session: { resume: true, list: true, history: { read: true, delta: false } },
        turn: { interrupt: true },
        action: {
          kinds: ["permission"],
          decisions: ["allow", "deny"],
          policyProfiles: [
            { id: "claude-on-request", label: "Ask before tool use", interactive: true, decisions: ["allow", "deny"] },
            { id: "claude-dont-ask", label: "Deny unapproved tools", interactive: false, decisions: [] },
          ],
        },
        permission: { interactive: true },
        model: { select: true, effort: true, effortOptions: CLAUDE_EFFORT_OPTIONS, changeWithinSession: false, catalog: CLAUDE_MODELS },
        workspace: { projectCustomizations: false, admission: true },
        operations: { compact: true, schedule: false, compactQueue: false },
        event: { nativePayload: false },
        tool: { dynamic: false },
      },
    };
  }

  function signalChild(state, signal, group = false) {
    if (state.exited || !state.child) return;
    try {
      if (group && process.platform !== "win32" && Number.isInteger(state.child.pid)) process.kill(-state.child.pid, signal);
      else state.child.kill(signal);
    } catch {}
  }

  function scheduleCancel(state) {
    if (state.cancelScheduled || state.exited) return;
    state.cancelScheduled = true;
    signalChild(state, "SIGINT");
    const terminate = setTimeout(() => signalChild(state, "SIGTERM", true), interruptGraceMs);
    const kill = setTimeout(() => signalChild(state, "SIGKILL", true), interruptGraceMs * 2);
    terminate.unref?.();
    kill.unref?.();
    state.cancelTimers.push(terminate, kill);
  }

  function isInteractivePermissionProfile(policyProfileId) {
    return policyProfileId === "claude-on-request";
  }

  // 未知のpolicyProfileIdはturn開始の早い段階(activeRuns登録より前)で弾く。
  // ここを通過した後のpermissionArgs()は、policyProfileIdが空/claude-dont-ask/
  // claude-on-requestのいずれかであることを前提にできる。
  function assertPolicyProfileId(policyProfileId) {
    if (policyProfileId && !isInteractivePermissionProfile(policyProfileId) && policyProfileId !== "claude-dont-ask") {
      throw agentError("capability_unsupported", "Claude permission profile is not supported", { backendId: "claude" });
    }
  }

  // profile → argv断片。--safe-modeは共通argvから外し、ここで各profileの責務として
  // 個別に持つ(スパイク実測: --safe-modeは明示的な--mcp-configも無効化するため、
  // interactiveでは使えない。§4.2)。
  function permissionArgs(policyProfileId, bridge) {
    if (isInteractivePermissionProfile(policyProfileId)) {
      const mcpConfig = {
        mcpServers: {
          bitty_permission: {
            command: process.execPath,
            args: [CLAUDE_PERMISSION_SHIM_PATH],
            env: { BITTY_PERMISSION_SOCKET: bridge.socketPath, BITTY_PERMISSION_TOKEN: bridge.token },
          },
        },
      };
      return [
        "--setting-sources", "",
        "--strict-mcp-config",
        "--mcp-config", JSON.stringify(mcpConfig),
        "--permission-prompt-tool", CLAUDE_PERMISSION_TOOL_NAME,
      ];
    }
    return ["--safe-mode", "--permission-mode", "dontAsk"];
  }

  async function startTurn({ runId, sessionRef, cwd, input, model, effort, policyProfileId, signal, resolveSession, setNativeProcessIdentity, emit }) {
    if (signal?.aborted) {
      const error = agentError("turn_failed", "Claude turn was interrupted before start", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    const detected = await runtime();
    if (!detected.binaryPath) {
      throw agentError("backend_unavailable", "Claude Code CLI is not installed or is not available on PATH", { backendId: "claude" });
    }
    if (!detected.supported) {
      throw agentError(
        "backend_version_unsupported",
        `Claude Code CLI ${minimumVersion} or newer is required (detected: ${detected.version || "unknown"})`,
        { backendId: "claude" },
      );
    }
    const selectedModel = String(model || "").trim().toLowerCase();
    if (selectedModel && !MODEL_ALIASES.has(selectedModel)) {
      throw agentError("turn_rejected", `Claude model must be one of: ${CLAUDE_MODELS.map((item) => item.modelId).join(", ")}`, { backendId: "claude" });
    }
    const selectedEffort = String(effort || "").trim().toLowerCase();
    if (selectedEffort && !CLAUDE_EFFORT_OPTIONS.includes(selectedEffort)) {
      throw agentError("turn_rejected", `Claude effort must be one of: ${CLAUDE_EFFORT_OPTIONS.join(", ")}`, { backendId: "claude" });
    }
    assertPolicyProfileId(policyProfileId);
    const blocks = Array.isArray(input?.blocks) ? input.blocks : [];
    if (blocks.some((block) => block?.type !== "text")) {
      throw agentError("capability_unsupported", "Claude v1 accepts text input only", { backendId: "claude" });
    }
    const prompt = blocks.map((block) => String(block.text || "")).join("\n").trim();
    if (!prompt) throw agentError("turn_rejected", "Claude prompt is empty", { backendId: "claude" });
    if (signal?.aborted) {
      const error = agentError("turn_failed", "Claude turn was interrupted before process launch", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    const requestedSessionId = String(sessionRef?.nativeSessionId || "").trim();
    const freshSessionId = requestedSessionId || generateSessionId();
    if (!SESSION_ID_PATTERN.test(freshSessionId)) {
      throw agentError("session_not_found", "Claude session ID is invalid", { backendId: "claude" });
    }
    if (requestedSessionId && selectedModel) {
      const savedFile = await findTranscriptFile(requestedSessionId);
      const savedModel = savedFile ? String((await transcriptMetadata(savedFile))?.modelId || "") : "";
      if (savedModel && savedModel !== selectedModel) {
        throw agentError("turn_rejected", "Claude model cannot be changed within an existing session", { backendId: "claude" });
      }
    }
    if (!requestedSessionId) await resolveSession({ backendId: "claude", nativeSessionId: freshSessionId });
    if (signal?.aborted) {
      const error = agentError("turn_failed", "Claude turn was interrupted before process launch", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    const interactive = isInteractivePermissionProfile(policyProfileId);
    const state = {
      child: null,
      exited: false,
      cancelRequested: false,
      cancelScheduled: false,
      cancelTimers: [],
      result: null,
      initialized: false,
      sessionId: "",
      stdoutBytes: 0,
      lineCount: 0,
      fragment: "",
      stderr: "",
      assistantIndex: 0,
      currentAssistant: null,
      completedAssistantMessageIds: new Set(),
      tools: new Map(),
      startedToolIds: new Set(),
      completedToolIds: new Set(),
      completedSubagentItemIds: new Set(),
      runningToolIds: new Set(),
      processing: Promise.resolve(),
      processIdentity: null,
      exitPromise: null,
      // interactive permission(claude-on-request)専用。respondToActionはactiveRuns
      // 経由でこのstateへ辿り着き、pendingを解決してemitする(Codexと同じ形)。
      pendingActions: new Map(),
      bridge: null,
      closed: false,
      resetNoOutput: null,
      emit,
    };
    activeRuns.set(runId, state);
    let noOutputTimer;
    let turnTimer;
    let exitPromise = null;
    let rejectProtocol;
    const protocolFailure = new Promise((_, reject) => { rejectProtocol = reject; });
    const resetNoOutput = () => {
      clearTimeout(noOutputTimer);
      // ローカルtool実行中(tool.started〜tool.completed間)、または承認待ち中は
      // CLIが無出力になるのが正常(5分超のビルド・無期限の承認待ち)。その間は
      // no-output監視を止め、turnTimerだけを上限とする。
      if (state.runningToolIds.size > 0 || state.pendingActions.size > 0) return;
      noOutputTimer = setTimeout(() => {
        const error = agentError("timeout", "Claude produced no output before timeout", { backendId: "claude" });
        error.nativeActivity = "unknown";
        rejectProtocol(error);
        scheduleCancel(state);
      }, noOutputTimeoutMs);
      noOutputTimer.unref?.();
    };
    state.resetNoOutput = resetNoOutput;

    // bridgeのonRequest callback。stdout処理チェーンとは独立に、CLIが承認委譲した
    // ツール呼び出しごとに1回呼ばれる(§4.5)。
    function handlePermissionRequest({ toolName, input, toolUseId }) {
      return new Promise((resolve) => {
        // system/init前(emitFromBackendの順序検査に触れる)、またはrun終了処理後
        // (staleなpending/activeActionsを作らない)のrequestは登録・emitせず即deny。
        if (!state.initialized || state.closed) {
          resolve({ decision: "deny" });
          return;
        }
        const requestId = `claude_action_${randomUUID()}`;
        state.pendingActions.set(requestId, { resolve, toolName });
        resetNoOutput();
        let inputSummary;
        try {
          inputSummary = JSON.stringify(input ?? {});
        } catch {
          inputSummary = String(input ?? "");
        }
        const title = `${toolName}: ${inputSummary}`.replace(/\s+/g, " ").slice(0, 300);
        emit("action.requested", {
          requestId,
          kind: "permission",
          title,
          toolCallId: toolUseId,
          decisions: ["allow", "deny"],
        });
      });
    }

    if (interactive) {
      try {
        state.bridge = await createClaudePermissionBridge({ onRequest: handlePermissionRequest });
      } catch (bridgeError) {
        activeRuns.delete(runId);
        const error = agentError("turn_failed", `Claude permission bridge could not be created: ${bridgeError.message}`, { backendId: "claude" });
        error.nativeActivity = "not_started";
        throw error;
      }
    }
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ...(requestedSessionId ? ["--resume", requestedSessionId] : ["--session-id", freshSessionId]),
      ...(!requestedSessionId && selectedModel ? ["--model", selectedModel] : []),
      ...(selectedEffort ? ["--effort", selectedEffort] : []),
      ...permissionArgs(policyProfileId, state.bridge),
    ];

    const startAssistant = () => {
      if (state.currentAssistant && !state.currentAssistant.completed) return state.currentAssistant;
      const assistant = {
        itemId: `${runId}:assistant:${state.assistantIndex++}`,
        completed: false,
        textDeltaSeen: false,
        text: "",
      };
      state.currentAssistant = assistant;
      emit("item.started", { itemId: assistant.itemId, itemType: "assistant" });
      return assistant;
    };
    const completeAssistant = (text = "", nativeMessageId = "", allowEmpty = false) => {
      if (nativeMessageId && state.completedAssistantMessageIds.has(nativeMessageId)) return;
      if (!text && !state.currentAssistant && !allowEmpty) return;
      const assistant = startAssistant();
      if (text && !assistant.textDeltaSeen) emit("content.delta", { itemId: assistant.itemId, contentIndex: 0, delta: text });
      assistant.completed = true;
      assistant.text = text;
      if (nativeMessageId) state.completedAssistantMessageIds.add(nativeMessageId);
      emit("item.completed", { itemId: assistant.itemId, itemType: "assistant", snapshotRevision: 1, ...(text ? { content: [{ type: "text", text }] } : {}) });
    };

    // tool.started発行はtoolCallIdを唯一の真実源として冪等化する。interactive
    // profileでは承認評価のタイミングにより、complete assistantメッセージ
    // (tool_use入り)がstream_eventのcontent_block_stopより先に届くことがある
    // (実測: CLI 2.1.238)。content_block_stop / assistantのtool_useループ /
    // user tool_resultの未startedフォールバック、3経路のどれが先に来ても
    // 同じtoolCallIdは一度しかemitしない(重複emitはemitFromBackendの
    // startedTools検査でprotocol_errorとして落ちるため)。
    const announceTool = ({ toolCallId, name, inputSummary, parentItemId, tracksRunning = true }) => {
      if (!toolCallId || state.startedToolIds.has(toolCallId)) return false;
      state.startedToolIds.add(toolCallId);
      if (tracksRunning) state.runningToolIds.add(toolCallId);
      resetNoOutput();
      emit("tool.started", { toolCallId, name, inputSummary, ...(parentItemId ? { parentItemId } : {}) });
      return true;
    };

    async function handleMessage(message) {
      const type = String(message?.type || "");
      if (type === "system" && message?.subtype === "init") {
        if (state.initialized) throw agentError("protocol_error", "Claude emitted system/init twice", { backendId: "claude" });
        const nativeSessionId = String(message.session_id || message.sessionId || "").trim();
        if (!SESSION_ID_PATTERN.test(nativeSessionId) || nativeSessionId !== freshSessionId) {
          throw agentError("protocol_error", "Claude returned an unexpected session ID", { backendId: "claude" });
        }
        state.initialized = true;
        state.sessionId = nativeSessionId;
        emit("turn.started", { nativeTurnId: String(message.message_id || runId), model: String(message.model || "") });
        return;
      }
      if (!state.initialized && type !== "system") {
        throw agentError("protocol_error", "Claude emitted content before system/init", { backendId: "claude" });
      }
      if (type === "stream_event") {
        const event = message.event || {};
        const index = Number.isInteger(event.index) ? event.index : 0;
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          state.tools.set(index, {
            id: String(event.content_block.id || `${runId}:tool:${index}`),
            name: String(event.content_block.name || "tool"),
            input: "",
            announced: false,
            parentItemId: String(message.parent_tool_use_id || ""),
          });
          return;
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const delta = String(event.delta.text || "");
          if (delta) {
            const assistant = startAssistant();
            assistant.textDeltaSeen = true;
            emit("content.delta", { itemId: assistant.itemId, contentIndex: index, delta });
          }
          return;
        }
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const tool = state.tools.get(index);
          if (tool) tool.input += String(event.delta.partial_json || "");
          return;
        }
        if (event.type === "content_block_stop") {
          const tool = state.tools.get(index);
          if (tool && !tool.announced) {
            // 同一Mapエントリ(index)の再stop防止。実際にemitするかはannounceTool
            // 側のtoolCallId冪等性に委ねる(先にassistant complete経路がこの
            // toolCallIdを一番乗りでannounceしている場合はここでは何もしない)。
            tool.announced = true;
            announceTool({
              toolCallId: tool.id,
              name: tool.name,
              inputSummary: tool.input.slice(0, 4096),
              parentItemId: tool.parentItemId,
            });
          }
          return;
        }
      }
      if (type === "assistant") {
        const parentItemId = String(message.parent_tool_use_id || message.message?.parent_tool_use_id || "").trim();
        if (parentItemId) {
          const itemId = String(message.uuid || message.message?.id || `${runId}:subagent:${parentItemId}`);
          if (state.completedSubagentItemIds.has(itemId)) return;
          state.completedSubagentItemIds.add(itemId);
          const text = extractText(message.message?.content);
          emit("item.started", { itemId, itemType: "subagent", parentItemId });
          emit("item.completed", {
            itemId, itemType: "subagent", parentItemId, snapshotRevision: 1,
            ...(text ? { content: [{ type: "text", text }] } : {}),
          });
          return;
        }
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
        let hasToolUse = false;
        for (const block of blocks) {
          if (block?.type !== "tool_use") continue;
          hasToolUse = true;
          announceTool({
            toolCallId: String(block.id || "").trim(),
            name: String(block.name || "tool"),
            inputSummary: JSON.stringify(block.input || {}).slice(0, 4096),
          });
        }
        const text = extractText(blocks);
        if (text || hasToolUse) {
          completeAssistant(text, String(message.uuid || message.message?.id || "").trim(), hasToolUse);
        }
        return;
      }
      if (type === "user") {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_result") continue;
          const toolCallId = String(block.tool_use_id || "");
          if (!toolCallId || state.completedToolIds.has(toolCallId)) continue;
          // このフォールバックはtool.startedの直後にtool.completedへ進むため、
          // runningToolIdsには入れない(no-output抑止を無駄に挟まない)。
          announceTool({ toolCallId, name: "tool", inputSummary: "", tracksRunning: false });
          emit("tool.completed", {
            toolCallId,
            status: block.is_error ? "failed" : "completed",
            resultSummary: extractText(block.content).slice(0, 4096),
          });
          state.completedToolIds.add(toolCallId);
          state.runningToolIds.delete(toolCallId);
          resetNoOutput();
        }
        return;
      }
      if (type === "system" && message?.subtype === "api_retry") {
        emit("provider.event", { backendId: "claude", nativeType: "system/api_retry", data: { attempt: Number(message.attempt || 0) } });
        return;
      }
      if (type === "result") {
        if (state.result) throw agentError("protocol_error", "Claude emitted more than one result", { backendId: "claude" });
        const resultSessionId = String(message.session_id || message.sessionId || "").trim();
        if (resultSessionId && resultSessionId !== freshSessionId) {
          throw agentError("protocol_error", "Claude result changed the session ID", { backendId: "claude" });
        }
        state.result = message;
        const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
        if (usage) {
          // Claudeのusageはcache read/creationが別建てで、context windowも
          // usage本体には無い。result.modelUsageのcontextWindowを補い、
          // 消費合計をtotal_tokensへ正規化してクライアントの%計算を成立させる。
          const totalTokens = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
            .reduce((sum, key) => sum + (Math.max(0, Number(usage[key]) || 0)), 0);
          const modelUsageEntries = Object.entries(
            message.modelUsage && typeof message.modelUsage === "object" ? message.modelUsage : {},
          );
          const contextWindow = modelUsageEntries
            .reduce((max, [, entry]) => Math.max(max, Number(entry?.contextWindow) || 0), 0);
          // モデルごとのcontext windowはtranscriptに残らない。履歴再表示時の%復元の
          // ために、ここで学習した実値をstoreへ永続化する(best-effort)。
          if (modelInfoStore?.set) {
            for (const [modelId, entry] of modelUsageEntries) {
              const alias = modelAliasOf(modelId);
              const windowTokens = Math.floor(Number(entry?.contextWindow) || 0);
              if (!alias || windowTokens <= 0) continue;
              void Promise.resolve(modelInfoStore.set("claude", alias, { contextWindowTokens: windowTokens }))
                .catch(() => {});
            }
          }
          emit("usage.updated", {
            usage: {
              ...usage,
              ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
              ...(contextWindow > 0 ? { context_window: contextWindow } : {}),
            },
          });
        }
      }
    }

    try {
      const child = spawnProcess(detected.binaryPath, args, {
        cwd,
        // MCP_TOOL_TIMEOUT/MCP_TIMEOUTはBackendが所有する値であり、運用者環境からは
        // 継承しない(safeEnvironment自体は変更しない)。承認待ちが長時間に及んでも
        // CLI側のMCP tool呼び出しタイムアウトに殺されないための明示設定(§4.5)。
        env: {
          ...safeEnvironment(environment),
          ...(interactive ? {
            MCP_TOOL_TIMEOUT: CLAUDE_PERMISSION_MCP_TIMEOUT_MS,
            MCP_TIMEOUT: CLAUDE_PERMISSION_MCP_TIMEOUT_MS,
          } : {}),
        },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      state.child = child;
      state.processIdentity = processIdentity(runFile, child.pid);
      const exit = new Promise((resolve, reject) => {
        child.once("error", (error) => {
          state.exited = true;
          error.nativeActivity = "not_started";
          reject(error);
        });
        child.once("exit", (code, signal) => {
          state.exited = true;
          resolve({ code, signal });
        });
      });
      exitPromise = exit;
      state.exitPromise = exit;
      if (setNativeProcessIdentity) {
        const identity = await state.processIdentity;
        if (!identity) throw agentError("protocol_error", "Claude process identity could not be verified", { backendId: "claude" });
        await setNativeProcessIdentity(identity);
      }
      resetNoOutput();
      turnTimer = setTimeout(() => {
        const error = agentError("timeout", "Claude turn timed out", { backendId: "claude" });
        error.nativeActivity = "unknown";
        rejectProtocol(error);
        scheduleCancel(state);
      }, turnTimeoutMs);
      turnTimer.unref?.();
      child.stdout.on("data", (chunk) => {
        resetNoOutput();
        state.stdoutBytes += chunk.length;
        if (state.stdoutBytes > MAX_STDOUT_BYTES) {
          const error = agentError("output_limit_exceeded", "Claude output exceeded the limit", { backendId: "claude" });
          error.nativeActivity = "unknown";
          rejectProtocol(error);
          scheduleCancel(state);
          return;
        }
        state.fragment += chunk.toString("utf8");
        const lines = state.fragment.split(/\r?\n/);
        state.fragment = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          state.lineCount += 1;
          if (state.lineCount > MAX_LINES || Buffer.byteLength(line) > MAX_LINE_BYTES) {
            const error = agentError("output_limit_exceeded", "Claude output record exceeded the limit", { backendId: "claude" });
            error.nativeActivity = "unknown";
            rejectProtocol(error);
            scheduleCancel(state);
            return;
          }
          state.processing = state.processing.then(() => handleMessage(JSON.parse(line)));
          state.processing.catch(rejectProtocol);
        }
      });
      child.stderr.on("data", (chunk) => {
        state.stderr = `${state.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      });
      child.stdin.on?.("error", () => {});
      child.stdin.write(prompt);
      child.stdin.end();
      const ended = await Promise.race([exit, protocolFailure]);
      if (state.fragment.trim()) {
        if (Buffer.byteLength(state.fragment) > MAX_LINE_BYTES) throw agentError("output_limit_exceeded", "Claude output fragment exceeded the limit", { backendId: "claude" });
        state.processing = state.processing.then(() => handleMessage(JSON.parse(state.fragment)));
      }
      await state.processing;
      if (state.cancelRequested) return { outcome: "interrupted", nativeTerminal: true };
      if (ended.code !== 0 || ended.signal) {
        const authFailed = isClaudeAuthFailure(state.stderr, claudeResultDiagnostic(state.result));
        const error = agentError(
          "turn_failed",
          authFailed
            ? "Claude Code CLI is not logged in. Run `claude auth login` and try again"
            : "Claude Code CLI exited unsuccessfully",
          { backendId: "claude" },
        );
        error.nativeActivity = "stopped";
        throw error;
      }
      if (!state.result) {
        const error = agentError("protocol_error", "Claude stream ended without a result", { backendId: "claude" });
        error.nativeActivity = "stopped";
        throw error;
      }
      if (state.result.is_error === true || String(state.result.subtype || "").includes("error")) {
        const error = agentError(
          "turn_failed",
          isClaudeAuthFailure(state.stderr, claudeResultDiagnostic(state.result))
            ? "Claude Code CLI is not logged in. Run `claude auth login` and try again"
            : "Claude reported a failed result",
          { backendId: "claude" },
        );
        error.nativeActivity = "stopped";
        throw error;
      }
      const finalText = String(state.result.result || "");
      if (!state.currentAssistant?.completed || (finalText && state.currentAssistant.text !== finalText)) {
        completeAssistant(finalText, `${runId}:result`);
      }
      return { outcome: "completed", nativeTerminal: true };
    } catch (error) {
      if (!state.exited) {
        scheduleCancel(state);
        if (exitPromise) {
          await Promise.race([
            exitPromise.catch(() => null),
            new Promise((resolve) => setTimeout(resolve, interruptGraceMs * 2 + 750)),
          ]);
        }
      }
      if (!error.nativeActivity) error.nativeActivity = !state.child ? "not_started" : state.exited ? "stopped" : "unknown";
      throw error;
    } finally {
      // run終了処理の開始を先に確定させる: 以後に滑り込むbridge requestはstaleな
      // pending/activeActionsを作らず即denyになる(handlePermissionRequestのガード)。
      state.closed = true;
      for (const pending of state.pendingActions.values()) pending.resolve({ decision: "deny" });
      state.pendingActions.clear();
      if (state.bridge) await state.bridge.close();
      clearTimeout(noOutputTimer);
      clearTimeout(turnTimer);
      for (const timer of state.cancelTimers) clearTimeout(timer);
      activeRuns.delete(runId);
    }
  }

  async function projectsRootReal() {
    try { return await fileSystem.realpath(projectsRoot); } catch { return ""; }
  }

  async function transcriptFiles() {
    const root = await projectsRootReal();
    if (!root) return [];
    const projects = (await fileSystem.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).slice(0, 2000);
    const files = [];
    scan: for (const project of projects) {
      const directory = path.join(root, project.name);
      for (const entry of (await fileSystem.readdir(directory, { withFileTypes: true }).catch(() => [])).slice(0, 5000)) {
        if (!entry.isFile() || !SESSION_ID_PATTERN.test(path.basename(entry.name, ".jsonl")) || path.extname(entry.name) !== ".jsonl") continue;
        const file = await fileSystem.realpath(path.join(directory, entry.name)).catch(() => "");
        if (file && inside(root, file)) files.push(file);
        if (files.length >= MAX_TRANSCRIPT_FILES) break scan;
      }
    }
    return files;
  }

  async function readTranscript(file) {
    const root = await projectsRootReal();
    const real = await fileSystem.realpath(file).catch(() => "");
    if (!root || !real || !inside(root, real)) throw agentError("history_unavailable", "Claude transcript path is invalid", { backendId: "claude" });
    const stat = await fileSystem.stat(real);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) throw agentError("history_unavailable", "Claude transcript is unavailable", { backendId: "claude" });
    const raw = String(await fileSystem.readFile(real, "utf8"));
    if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES) {
      throw agentError("history_unavailable", "Claude transcript grew beyond the read limit", { backendId: "claude" });
    }
    const lines = raw.split(/\r?\n/);
    if (lines.length > MAX_LINES) throw agentError("history_unavailable", "Claude transcript has too many records", { backendId: "claude" });
    const records = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      try { records.push({ index, value: JSON.parse(line) }); } catch {}
    }
    return { real, stat, records };
  }

  function transcriptCwd(records) {
    for (const record of records) {
      const cwd = String(record.value?.cwd || record.value?.message?.cwd || "").trim();
      if (path.isAbsolute(cwd)) return path.resolve(cwd);
    }
    return "";
  }

  function transcriptModelId(records) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const alias = modelAliasOf(records[index]?.value?.message?.model || records[index]?.value?.model);
      if (alias) return alias;
    }
    return "";
  }

  // transcript末尾のusage(メイン会話のみ)からcontext使用率を復元する。
  // /compact境界より新しいusageが無い間は、境界レコードのcompactMetadata.postTokens
  // (CLI自身が記録する圧縮後トークン数)から復元する。
  async function transcriptContextUsage(records) {
    if (!modelInfoStore?.get) return null;
    let totalTokens = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const value = records[index]?.value;
      if (String(value?.subtype || "") === "compact_boundary") {
        totalTokens = Math.max(0, Math.floor(Number(value?.compactMetadata?.postTokens) || 0));
        break;
      }
      if (value?.isSidechain === true) continue;
      const usage = value?.message?.usage;
      if (usage && typeof usage === "object") {
        totalTokens = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
          .reduce((sum, key) => sum + Math.max(0, Number(usage[key]) || 0), 0);
        break;
      }
    }
    const modelId = transcriptModelId(records);
    if (totalTokens <= 0 || !modelId) return null;
    const info = await Promise.resolve(modelInfoStore.get("claude", modelId)).catch(() => null);
    const contextWindowTokens = Math.floor(Number(info?.contextWindowTokens) || 0);
    if (contextWindowTokens <= 0) return null;
    return {
      usedPct: Math.max(0, Math.min(100, Math.round((totalTokens / contextWindowTokens) * 100))),
      totalTokens,
      contextWindowTokens,
    };
  }

  // transcript由来のcwdはsymlink経由(例: /tmp→/private/tmp)でも一致判定できるよう
  // realpathへ正規化して比較する。serviceから渡るcwdはrealpath済みcanonical。
  const realCwdCache = new Map();
  async function realpathCwd(cwd) {
    const key = String(cwd || "");
    if (!key) return "";
    if (realCwdCache.has(key)) return realCwdCache.get(key);
    const real = await fileSystem.realpath(key).catch(() => path.resolve(key));
    if (realCwdCache.size >= MAX_TRANSCRIPT_FILES) realCwdCache.clear();
    realCwdCache.set(key, real);
    return real;
  }

  // 一覧・probe・resume整合チェックのたびに全transcriptを全文読みしないための
  // メタデータキャッシュ。size+mtimeMsが不変ならファイル本文を読まずに再利用する。
  const transcriptMetadataCache = new Map();
  async function transcriptMetadata(file) {
    const stat = await fileSystem.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    const cached = transcriptMetadataCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached, stat };
    }
    const transcript = await readTranscript(file).catch(() => null);
    if (!transcript) return null;
    const firstUser = transcript.records.find((record) => record.value?.type === "user"
      && !classifyHistoryItemType(record.value, extractText(record.value?.message?.content)));
    const metadata = {
      size: transcript.stat.size,
      mtimeMs: transcript.stat.mtimeMs,
      realCwd: await realpathCwd(transcriptCwd(transcript.records)),
      title: extractText(firstUser?.value?.message?.content).slice(0, 200),
      modelId: transcriptModelId(transcript.records),
    };
    if (transcriptMetadataCache.size >= MAX_TRANSCRIPT_FILES) transcriptMetadataCache.clear();
    transcriptMetadataCache.set(file, metadata);
    return { ...metadata, stat: transcript.stat };
  }

  async function findTranscriptFile(sessionId) {
    if (!SESSION_ID_PATTERN.test(String(sessionId || ""))) return null;
    const suffix = `${sessionId}.jsonl`;
    for (const file of await transcriptFiles()) if (path.basename(file) === suffix) return file;
    return null;
  }

  async function findTranscript(sessionId) {
    const file = await findTranscriptFile(sessionId);
    return file ? await readTranscript(file) : null;
  }

  async function resolveSessionCwd(sessionRef) {
    // nativeデータ源(transcript)のcwdが真実。bindingはtranscript未発見時の
    // フォールバックに限定し、serviceのbinding-vs-native照合を骨抜きにしない。
    const file = await findTranscriptFile(sessionRef?.nativeSessionId);
    const metadata = file ? await transcriptMetadata(file) : null;
    if (metadata?.realCwd) return metadata.realCwd;
    const binding = await sessionStore.getBinding(sessionRef);
    if (binding?.canonicalCwd) return binding.canonicalCwd;
    throw agentError("session_not_found", "Claude session was not found", { backendId: "claude" });
  }

  // 一覧の並び順キー(updatedAt desc → sessionId desc)。ページ継続cursorは
  // このキーのkeysetで、entryがcursorより後(古い側)に並ぶ時だけ正を返す。
  // 値はISO 8601(UTC・固定長)とUUIDなので、ordinal比較で辞書順=時系列になる。
  function compareOrdinalDesc(a, b) {
    return a < b ? 1 : a > b ? -1 : 0;
  }
  function compareListPageKeys(a, b) {
    return compareOrdinalDesc(String(a?.updatedAt || ""), String(b?.updatedAt || ""))
      || compareOrdinalDesc(String(a?.sessionId || ""), String(b?.sessionId || ""));
  }

  async function listSessions({ cwd, limit = 50, cursor = "" }) {
    const canonicalCwd = await realpathCwd(path.resolve(String(cwd || "")));
    const cursorRaw = String(cursor || "").trim();
    const cursorKey = cursorRaw ? cursorDecode(cursorRaw) : null;
    if (cursorRaw && !String(cursorKey?.sessionId || "").trim()) {
      throw agentError("turn_rejected", "session list cursor is invalid", { backendId: "claude" });
    }
    const sessions = [];
    for (const file of await transcriptFiles()) {
      const metadata = await transcriptMetadata(file);
      if (!metadata || metadata.realCwd !== canonicalCwd) continue;
      const nativeSessionId = path.basename(file, ".jsonl");
      sessions.push({
        sessionRef: { backendId: "claude", nativeSessionId },
        canonicalCwd,
        updatedAt: metadata.stat.mtime.toISOString(),
        title: metadata.title,
        modelId: metadata.modelId,
        sourceKind: "cli",
      });
    }
    const pageKey = (session) => ({ updatedAt: session.updatedAt, sessionId: session.sessionRef.nativeSessionId });
    sessions.sort((a, b) => compareListPageKeys(pageKey(a), pageKey(b)));
    const positioned = cursorKey
      ? sessions.filter((session) => compareListPageKeys(pageKey(session), {
        updatedAt: String(cursorKey.updatedAt || ""),
        sessionId: String(cursorKey.sessionId || ""),
      }) > 0)
      : sessions;
    const page = positioned.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
    return {
      // 各項目のcursorは「この項目の位置」。all-backends合成層のページ全体カット用。
      sessions: page.map((session) => ({ ...session, cursor: cursorEncode(pageKey(session)) })),
      ...(positioned.length > page.length && page.length > 0
        ? { cursor: cursorEncode(pageKey(page[page.length - 1])) }
        : {}),
    };
  }

  async function readHistory({ sessionRef, cursor, sinceCursor, limit = 100 }) {
    if (sinceCursor) throw agentError("capability_unsupported", "Claude history delta is not supported", { backendId: "claude" });
    const transcript = await findTranscript(sessionRef?.nativeSessionId);
    if (!transcript) throw agentError("session_not_found", "Claude session was not found", { backendId: "claude" });
    const identity = `${String(transcript.stat.dev)}:${String(transcript.stat.ino)}:${transcript.stat.size}:${transcript.stat.mtimeMs}`;
    const decoded = cursor ? cursorDecode(cursor) : null;
    if (cursor && (!decoded || decoded.identity !== identity || !Number.isInteger(decoded.offset))) {
      throw agentError("history_cursor_invalid", "Claude history cursor is invalid", { backendId: "claude" });
    }
    const display = [];
    for (const record of transcript.records) {
      const type = String(record.value?.type || "");
      if (type !== "user" && type !== "assistant") continue;
      const text = extractText(record.value?.message?.content);
      if (!text) continue;
      const itemType = classifyHistoryItemType(record.value, text);
      display.push({
        id: String(record.value?.uuid || `${sessionRef.nativeSessionId}:${record.index}`),
        role: type,
        content: [{ type: "text", text }],
        ...(record.value?.timestamp ? { createdAt: String(record.value.timestamp) } : {}),
        ...(itemType ? { itemType } : {}),
      });
    }
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const end = decoded ? decoded.offset : display.length;
    const start = Math.max(0, end - pageLimit);
    const contextUsage = await transcriptContextUsage(transcript.records);
    return {
      items: display.slice(start, end),
      modelId: transcriptModelId(transcript.records),
      olderCursor: start > 0 ? cursorEncode({ identity, offset: start }) : null,
      newerCursor: null,
      ...(contextUsage ? { contextUsage } : {}),
    };
  }

  // Claude CLIはheadlessでも/compactスラッシュコマンドを実行できる(実測: 2.1.238。
  // 成功時はresult subtype=successで、transcriptへcompact_boundary+要約が記録される)。
  async function compactSession({ sessionRef }) {
    const detected = await runtime();
    if (!detected.binaryPath) {
      const error = agentError("backend_unavailable", "Claude Code CLI is not installed or is not available on PATH", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    if (!detected.supported) {
      const error = agentError(
        "backend_version_unsupported",
        `Claude Code CLI ${minimumVersion} or newer is required (detected: ${detected.version || "unknown"})`,
        { backendId: "claude" },
      );
      error.nativeActivity = "not_started";
      throw error;
    }
    const sessionId = String(sessionRef?.nativeSessionId || "").trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      const error = agentError("session_not_found", "Claude session ID is invalid", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    // --resumeはcwd由来のprojectディレクトリからセッションを探すため、cwd一致が必須
    const cwd = await resolveSessionCwd(sessionRef);
    let stdout = "";
    let stderr = "";
    try {
      const result = await runFile(detected.binaryPath, [
        "-p", "--output-format", "json", "--safe-mode", "--resume", sessionId, "/compact",
      ], { cwd, env: safeEnvironment(environment), timeout: compactTimeoutMs, encoding: "utf8", maxBuffer: MAX_STDOUT_BYTES });
      stdout = String(typeof result === "string" ? result : result?.stdout || "");
      stderr = String(result?.stderr || "");
    } catch (executionError) {
      const error = agentError(
        "turn_failed",
        isClaudeAuthFailure(executionError?.stdout, executionError?.stderr)
          ? "Claude Code CLI is not logged in. Run `claude auth login` and try again"
          : "Claude compact failed",
        { backendId: "claude" },
      );
      error.nativeActivity = "stopped";
      throw error;
    }
    let parsed = null;
    try { parsed = JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1) || ""); } catch {}
    if (!parsed || parsed.type !== "result" || parsed.is_error === true || String(parsed.subtype || "") !== "success") {
      const error = agentError(
        "turn_failed",
        isClaudeAuthFailure(stdout, stderr)
          ? "Claude Code CLI is not logged in. Run `claude auth login` and try again"
          : "Claude compact did not complete",
        { backendId: "claude" },
      );
      error.nativeActivity = "stopped";
      throw error;
    }
    return { sessionRef, method: "cli/compact", accepted: true };
  }

  return {
    backendId: "claude",
    defaultDiscoveredSessionMode: "neutral",
    getStatus,
    startTurn,
    resolveSessionCwd,
    listSessions,
    readHistory,
    compactSession,
    listModels: async () => CLAUDE_MODELS,
    async interrupt({ runId }) {
      const state = activeRuns.get(runId);
      if (!state || state.exited) return;
      state.cancelRequested = true;
      scheduleCancel(state);
    },
    async respondToAction({ runId, requestId, decision }) {
      const state = activeRuns.get(runId);
      const pending = state?.pendingActions.get(requestId);
      if (!pending) throw agentError("action_expired", "Claude permission request is no longer active", { backendId: "claude" });
      state.pendingActions.delete(requestId);
      pending.resolve({ decision: decision === "allow" ? "allow" : "deny" });
      // 抑止条件(pendingActions.size > 0)が解けるため、無出力監視を再開する。
      state.resetNoOutput();
      state.emit("action.resolved", { requestId, outcome: "answered", decision });
    },
    async recoverSession({ lease }) {
      let identity;
      try { identity = JSON.parse(String(lease?.nativeProcessIdentity || "")); } catch { return { nativeActivity: "unknown" }; }
      const pid = Number(identity?.pid);
      const expected = String(identity?.startedAt || "").trim();
      if (!Number.isInteger(pid) || pid <= 0 || !expected) return { nativeActivity: "unknown" };
      const current = await processIdentity(runFile, pid);
      if (!current) return { nativeActivity: "stopped" };
      let currentIdentity;
      try { currentIdentity = JSON.parse(current); } catch { return { nativeActivity: "unknown" }; }
      if (currentIdentity.startedAt !== expected) return { nativeActivity: "stopped" };
      try { process.kill(pid, "SIGINT"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, interruptGraceMs));
      if (await processIdentity(runFile, pid)) {
        try { process.kill(-pid, "SIGTERM"); } catch {}
        await new Promise((resolve) => setTimeout(resolve, interruptGraceMs));
      }
      if (await processIdentity(runFile, pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, interruptGraceMs)));
      }
      return { nativeActivity: await processIdentity(runFile, pid) ? "unknown" : "stopped" };
    },
    async close() {
      const exits = [];
      for (const state of activeRuns.values()) {
        state.cancelRequested = true;
        scheduleCancel(state);
        if (state.exitPromise) {
          exits.push(Promise.race([
            state.exitPromise.catch(() => null),
            new Promise((resolve) => setTimeout(resolve, interruptGraceMs * 2 + 750)),
          ]));
        }
      }
      await Promise.all(exits);
    },
  };
}
