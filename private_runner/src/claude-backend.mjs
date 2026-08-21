import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { agentError } from "./agent/agent-protocol.mjs";

const execFile = promisify(execFileCallback);
const MINIMUM_VERSION = "2.1.214";
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function createClaudeBackend({
  enabled = false,
  binary = "claude",
  minimumVersion = MINIMUM_VERSION,
  environment = process.env,
  homeDirectory = os.homedir(),
  projectsRoot = path.join(homeDirectory, ".claude", "projects"),
  fileSystem = fs,
  spawnProcess = spawn,
  runFile = execFile,
  sessionStore,
  noOutputTimeoutMs = 5 * 60 * 1000,
  turnTimeoutMs = 24 * 60 * 60 * 1000,
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
    return await probePromise;
  }

  async function getStatus() {
    if (!enabled) {
      return {
        backendId: "claude",
        available: false,
        auth: { state: "unknown" },
        readiness: { ready: false, reason: "Claude Backend is disabled" },
        capabilities: {
          session: { resume: false, list: false, history: { read: false, delta: false } },
          turn: { interrupt: false },
          action: { kinds: [], decisions: [], policyProfiles: [] },
          permission: { interactive: false }, model: { select: false, effort: false },
          workspace: { projectCustomizations: false, admission: true },
          operations: { compact: false }, event: { nativePayload: false }, tool: { dynamic: false },
        },
      };
    }
    const detected = await runtime();
    const ready = Boolean(detected.binaryPath) && detected.supported;
    let reason = "";
    if (!detected.binaryPath) reason = "Claude Code CLI was not found";
    else if (!detected.supported) reason = `Claude Code ${minimumVersion} or newer is required`;
    return {
      backendId: "claude",
      available: Boolean(detected.binaryPath),
      auth: { state: detected.binaryPath ? "unknown" : "unavailable" },
      runtime: { binaryPath: detected.binaryPath || undefined, version: detected.version || undefined },
      readiness: { ready, ...(reason ? { reason } : {}) },
      capabilities: {
        session: { resume: ready, list: ready, history: { read: ready, delta: false } },
        turn: { interrupt: ready },
        action: {
          kinds: [],
          decisions: [],
          policyProfiles: ready
            ? [{ id: "claude-dont-ask", label: "Deny unapproved tools", interactive: false, decisions: [] }]
            : [],
        },
        permission: { interactive: false },
        model: { select: false, effort: false },
        workspace: { projectCustomizations: false, admission: true },
        operations: { compact: false },
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

  function permissionArgs(policyProfileId) {
    if (policyProfileId && policyProfileId !== "claude-dont-ask") {
      throw agentError("capability_unsupported", "Claude permission profile is not supported", { backendId: "claude" });
    }
    return ["--permission-mode", "dontAsk"];
  }

  async function startTurn({ runId, sessionRef, cwd, input, model, effort, policyProfileId, signal, resolveSession, setNativeProcessIdentity, emit }) {
    if (signal?.aborted) {
      const error = agentError("turn_failed", "Claude turn was interrupted before start", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    const detected = await runtime();
    if (!enabled || !detected.binaryPath || !detected.supported) {
      throw agentError(detected.binaryPath ? "backend_version_unsupported" : "backend_unavailable", "Claude Backend is not ready", { backendId: "claude" });
    }
    if (model || effort) throw agentError("capability_unsupported", "Claude model selection is not enabled", { backendId: "claude" });
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
    if (!requestedSessionId) await resolveSession({ backendId: "claude", nativeSessionId: freshSessionId });
    if (signal?.aborted) {
      const error = agentError("turn_failed", "Claude turn was interrupted before process launch", { backendId: "claude" });
      error.nativeActivity = "not_started";
      throw error;
    }
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--safe-mode",
      ...(requestedSessionId ? ["--resume", requestedSessionId] : ["--session-id", freshSessionId]),
      ...permissionArgs(policyProfileId),
    ];
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
      processing: Promise.resolve(),
      processIdentity: null,
      exitPromise: null,
    };
    activeRuns.set(runId, state);
    let noOutputTimer;
    let turnTimer;
    let exitPromise = null;
    let rejectProtocol;
    const protocolFailure = new Promise((_, reject) => { rejectProtocol = reject; });
    const resetNoOutput = () => {
      clearTimeout(noOutputTimer);
      noOutputTimer = setTimeout(() => {
        const error = agentError("timeout", "Claude produced no output before timeout", { backendId: "claude" });
        error.nativeActivity = "unknown";
        rejectProtocol(error);
        scheduleCancel(state);
      }, noOutputTimeoutMs);
      noOutputTimer.unref?.();
    };

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
    const completeAssistant = (text = "", nativeMessageId = "") => {
      if (nativeMessageId && state.completedAssistantMessageIds.has(nativeMessageId)) return;
      const assistant = startAssistant();
      if (text && !assistant.textDeltaSeen) emit("content.delta", { itemId: assistant.itemId, contentIndex: 0, delta: text });
      assistant.completed = true;
      assistant.text = text;
      if (nativeMessageId) state.completedAssistantMessageIds.add(nativeMessageId);
      emit("item.completed", { itemId: assistant.itemId, itemType: "assistant", snapshotRevision: 1, ...(text ? { content: [{ type: "text", text }] } : {}) });
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
            tool.announced = true;
            state.startedToolIds.add(tool.id);
            emit("tool.started", {
              toolCallId: tool.id,
              name: tool.name,
              inputSummary: tool.input.slice(0, 4096),
              ...(tool.parentItemId ? { parentItemId: tool.parentItemId } : {}),
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
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_use") continue;
          const toolCallId = String(block.id || "").trim();
          if (!toolCallId || state.startedToolIds.has(toolCallId)) continue;
          state.startedToolIds.add(toolCallId);
          emit("tool.started", {
            toolCallId,
            name: String(block.name || "tool"),
            inputSummary: JSON.stringify(block.input || {}).slice(0, 4096),
          });
        }
        completeAssistant(
          extractText(message.message?.content),
          String(message.uuid || message.message?.id || "").trim(),
        );
        return;
      }
      if (type === "user") {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_result") continue;
          const toolCallId = String(block.tool_use_id || "");
          if (!toolCallId || state.completedToolIds.has(toolCallId)) continue;
          if (toolCallId && !state.startedToolIds.has(toolCallId)) {
            state.startedToolIds.add(toolCallId);
            emit("tool.started", { toolCallId, name: "tool", inputSummary: "" });
          }
          emit("tool.completed", {
            toolCallId,
            status: block.is_error ? "failed" : "completed",
            resultSummary: extractText(block.content).slice(0, 4096),
          });
          state.completedToolIds.add(toolCallId);
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
        if (usage) emit("usage.updated", { usage });
      }
    }

    try {
      const child = spawnProcess(detected.binaryPath, args, {
        cwd,
        env: safeEnvironment(environment),
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
        const error = agentError("turn_failed", "Claude process exited unsuccessfully", { backendId: "claude" });
        error.nativeActivity = "stopped";
        throw error;
      }
      if (!state.result) {
        const error = agentError("protocol_error", "Claude stream ended without a result", { backendId: "claude" });
        error.nativeActivity = "stopped";
        throw error;
      }
      if (state.result.is_error === true || String(state.result.subtype || "").includes("error")) {
        const error = agentError("turn_failed", "Claude reported a failed result", { backendId: "claude" });
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

  async function findTranscript(sessionId) {
    if (!SESSION_ID_PATTERN.test(String(sessionId || ""))) return null;
    const suffix = `${sessionId}.jsonl`;
    for (const file of await transcriptFiles()) if (path.basename(file) === suffix) return await readTranscript(file);
    return null;
  }

  async function resolveSessionCwd(sessionRef) {
    const binding = await sessionStore.getBinding(sessionRef);
    if (binding?.canonicalCwd) return binding.canonicalCwd;
    const transcript = await findTranscript(sessionRef?.nativeSessionId);
    const cwd = transcriptCwd(transcript?.records || []);
    if (!cwd) throw agentError("session_not_found", "Claude session was not found", { backendId: "claude" });
    return cwd;
  }

  async function listSessions({ cwd, limit = 50 }) {
    const canonicalCwd = path.resolve(String(cwd || ""));
    const sessions = [];
    for (const file of await transcriptFiles()) {
      const transcript = await readTranscript(file).catch(() => null);
      if (!transcript || transcriptCwd(transcript.records) !== canonicalCwd) continue;
      const nativeSessionId = path.basename(file, ".jsonl");
      const firstUser = transcript.records.find((record) => record.value?.type === "user");
      sessions.push({
        sessionRef: { backendId: "claude", nativeSessionId },
        canonicalCwd,
        updatedAt: transcript.stat.mtime.toISOString(),
        title: extractText(firstUser?.value?.message?.content).slice(0, 200),
      });
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: sessions.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))) };
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
      display.push({
        id: String(record.value?.uuid || `${sessionRef.nativeSessionId}:${record.index}`),
        role: type,
        content: [{ type: "text", text }],
        ...(record.value?.timestamp ? { createdAt: String(record.value.timestamp) } : {}),
        ...(record.value?.isSidechain === true ? { itemType: "sidechain" } : {}),
      });
    }
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const end = decoded ? decoded.offset : display.length;
    const start = Math.max(0, end - pageLimit);
    return {
      items: display.slice(start, end),
      olderCursor: start > 0 ? cursorEncode({ identity, offset: start }) : null,
      newerCursor: null,
    };
  }

  return {
    backendId: "claude",
    defaultDiscoveredSessionMode: "neutral",
    getStatus,
    startTurn,
    resolveSessionCwd,
    listSessions,
    readHistory,
    listModels: async () => [],
    async interrupt({ runId }) {
      const state = activeRuns.get(runId);
      if (!state || state.exited) return;
      state.cancelRequested = true;
      scheduleCancel(state);
    },
    async respondToAction() {
      throw agentError("capability_unsupported", "Claude interactive permission is not enabled", { backendId: "claude" });
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
