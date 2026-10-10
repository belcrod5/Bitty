import { CALENDAR_DYNAMIC_TOOLS_CONTRACT } from "./calendar-tool-service.mjs";
import { randomUUID } from "node:crypto";
import { isValidUserInputResponse } from "./codex-user-input.mjs";

const CODEX_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const VALID_EFFORTS = new Set(CODEX_EFFORT_OPTIONS);
const SUCCESSFUL_TURN_STATUSES = new Set(["", "completed", "complete", "succeeded", "success"]);
const INTERRUPTED_TURN_STATUSES = new Set(["interrupted", "cancelled", "canceled"]);
const ACTIVE_TURN_STATUSES = new Set(["inprogress", "in_progress", "running", "active", "waiting", "waitingapproval", "waiting_approval"]);
const STOPPED_TURN_STATUSES = new Set(["completed", "complete", "succeeded", "success", "interrupted", "cancelled", "canceled", "failed"]);
function dynamicToolsFailure(phase) {
  return new Error(JSON.stringify({
    ok: false,
    error: {
      code: "codex_dynamic_tools_incompatible",
      message: "Dynamic Tools互換性エラーです。phaseを確認し、Bittyのcalendar tool adapterを現行schemaへ更新してください。",
      retryable: false,
      expectedContract: CALENDAR_DYNAMIC_TOOLS_CONTRACT,
      phase,
    },
  }));
}

async function calendarDynamicToolsPreflight(client) {
  let capabilities;
  try {
    capabilities = await client.request("modelProvider/capabilities/read", {}, 30000);
  } catch {
    throw dynamicToolsFailure("thread_start");
  }
  if (capabilities?.namespaceTools !== true) throw dynamicToolsFailure("thread_start");
  await client.request("config/read", {}, 30000);
  const listed = await client.request("plugin/list", {}, 30000);
  if (!Array.isArray(listed?.marketplaces)) throw new Error("calendar_api_failed");
  for (const marketplace of listed.marketplaces) {
    if (!Array.isArray(marketplace?.plugins)) throw new Error("calendar_api_failed");
    for (const plugin of marketplace.plugins) {
      if (plugin?.enabled !== true) continue;
      const pluginName = String(plugin?.name || "").trim();
      if (!pluginName) throw new Error("calendar_api_failed");
      const params = { pluginName };
      if (typeof marketplace.path === "string" && marketplace.path) params.marketplacePath = marketplace.path;
      else if (typeof marketplace.name === "string" && marketplace.name) params.remoteMarketplaceName = marketplace.name;
      else throw new Error("calendar_api_failed");
      await client.request("plugin/read", params, 30000);
    }
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return "";
}

async function initializeCodexClient(client, clientName) {
  await client.openPromise;
  await client.request("initialize", {
    clientInfo: { name: clientName, title: clientName, version: "0.1.0" },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
  }, 30000);
  client.notify("initialized", {});
}

export async function listCodexModelsFromAppServer(createClient, clientName) {
  const client = createClient({});
  const catalog = [];
  const seenCursors = new Set();
  let cursor = "";
  try {
    await initializeCodexClient(client, `${clientName}-models`);
    do {
      const page = await client.request("model/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, 30000);
      if (!Array.isArray(page?.data)) throw new Error("Codex app-server returned an invalid model catalog");
      for (const item of page.data) {
        const modelId = firstNonEmptyString(item?.model, item?.id);
        if (!modelId || item?.hidden === true) continue;
        const effortOptions = (Array.isArray(item?.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
          : [])
          .map((option) => String(option?.reasoningEffort || "").trim().toLowerCase())
          .filter((effort) => VALID_EFFORTS.has(effort));
        catalog.push({
          modelId,
          label: firstNonEmptyString(item?.displayName, modelId),
          effortOptions,
        });
      }
      cursor = String(page?.nextCursor || "").trim();
      if (cursor && seenCursors.has(cursor)) throw new Error("Codex app-server repeated a model catalog cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return catalog;
  } finally {
    client.close();
  }
}

export function getCodexTurnEventIdentity(paramsRaw) {
  const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw : {};
  return {
    threadId: firstNonEmptyString(
      params.threadId,
      params.thread_id,
      params.sessionId,
      params.session_id,
      params.thread?.id,
      params.turn?.threadId,
      params.turn?.thread_id,
      params.turn?.thread?.id,
    ),
    turnId: firstNonEmptyString(
      params.turnId,
      params.turn_id,
      params.turn?.id,
      params.turn?.turnId,
    ),
  };
}

export function codexTurnEventMatches(params, expected) {
  const actual = getCodexTurnEventIdentity(params);
  const threadId = String(expected?.threadId || "").trim();
  const turnId = String(expected?.turnId || "").trim();
  return Boolean(
    threadId && turnId &&
    actual.threadId === threadId &&
    actual.turnId === turnId
  );
}

export function extractCodexAgentMessageText(itemRaw) {
  if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) return "";
  const item = itemRaw;
  const directText = firstNonEmptyString(item.text, item.message?.text);
  if (directText) return directText;
  const chunks = [];
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    if (String(part.type || "").trim() === "localImage") {
      const localPath = firstNonEmptyString(part.path);
      if (localPath) chunks.push(`[localImage] ${localPath}`);
      continue;
    }
    const text = firstNonEmptyString(part.text, part.value);
    if (text) chunks.push(text);
  }
  return chunks.join("").trim();
}

export async function startCodexTurn({
  client,
  clientName,
  threadId = "",
  inputText,
  input,
  cwd,
  model = "",
  effort = "",
  approvalPolicy = "on-request",
  onThreadResolved,
  onBeforeTurnStart,
  onTurnStarted,
  dynamicTools,
  enableUserInput = false,
  developerInstructions = "",
}) {
  const normalizedInput = Array.isArray(input?.blocks)
    ? input.blocks.map((block) => block?.type === "image"
      ? { type: "localImage", path: String(block.localRef || "").trim() }
      : { type: "text", text: String(block?.text || "").trim() })
      .filter((block) => block.type === "localImage" ? block.path : block.text)
    : [{ type: "text", text: String(inputText || "").trim() }].filter((block) => block.text);
  const directory = String(cwd || "").trim();
  const normalizedDeveloperInstructions = String(developerInstructions || "").trim();
  let activeThreadId = String(threadId || "").trim();
  const threadConfig = { "features.default_mode_request_user_input": enableUserInput };
  if (normalizedInput.length === 0) throw new Error("input is required");

  // resume時のexcludeTurns(experimental API)を常用するため無条件で有効化
  await initializeCodexClient(client, clientName);

  if (dynamicTools) await calendarDynamicToolsPreflight(client);

  if (activeThreadId) {
    const resumed = await client.request("thread/resume", {
      threadId: activeThreadId,
      cwd: directory || undefined,
      excludeTurns: true,
      config: threadConfig,
      ...(normalizedDeveloperInstructions ? { developerInstructions: normalizedDeveloperInstructions } : {}),
    }, 30000).catch(() => null);
    activeThreadId = String(resumed?.thread?.id || activeThreadId).trim();
  } else {
    const started = await client.request("thread/start", {
      cwd: directory || undefined,
      serviceName: clientName,
      approvalPolicy,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: threadConfig,
      ...(dynamicTools ? { dynamicTools } : {}),
      ...(normalizedDeveloperInstructions ? { developerInstructions: normalizedDeveloperInstructions } : {}),
    }, 30000);
    activeThreadId = String(started?.thread?.id || "").trim();
  }
  if (!activeThreadId) throw new Error("thread id was not returned from app-server");
  await onThreadResolved?.({ threadId: activeThreadId });

  const params = {
    threadId: activeThreadId,
    input: normalizedInput,
    cwd: directory || undefined,
    approvalPolicy,
  };
  const normalizedModel = String(model || "").trim();
  if (normalizedModel) params.model = normalizedModel;
  const normalizedEffort = String(effort || "").trim().toLowerCase();
  if (VALID_EFFORTS.has(normalizedEffort)) params.effort = normalizedEffort;
  onBeforeTurnStart?.({ threadId: activeThreadId });
  const started = await client.request("turn/start", params, 30000);
  const turnId = String(started?.turn?.id || "").trim();
  if (!turnId) throw new Error("turn id was not returned from app-server");
  onTurnStarted?.({ threadId: activeThreadId, turnId });
  return { threadId: activeThreadId, turnId };
}

function codexTurnStatus(params) {
  return String(params?.turn?.status || params?.status || "").trim().toLowerCase();
}

// turn/completedのparamsからcontext usageを取り出す。usage本体にcontext windowが
// 無い場合はparams/turnレベルのwindowを補って返す(クライアントの%計算に必要)。
function codexTurnCompletedUsage(paramsRaw) {
  const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw : {};
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  const usage = [
    params.contextUsage, params.context_usage, params.usage, params.tokenUsage, params.token_usage,
    turn.contextUsage, turn.context_usage, turn.usage, turn.lastUsage, turn.last_usage,
    turn.tokenUsage, turn.token_usage,
  ].find((candidate) => candidate && typeof candidate === "object");
  if (!usage) return null;
  const windowOf = (source) => {
    const value = Number(source?.contextWindowTokens ?? source?.context_window_tokens ?? source?.context_window);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const contextWindow = windowOf(usage) || windowOf(turn) || windowOf(params);
  if (!windowOf(usage) && contextWindow > 0) return { ...usage, context_window: contextWindow };
  return usage;
}

function codexItemId(params, fallback) {
  return firstNonEmptyString(params?.item?.id, params?.itemId, params?.item_id, fallback);
}

function codexCommandText(itemRaw) {
  const command = itemRaw?.command;
  if (Array.isArray(command)) {
    return command.map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  }
  return String(command || "").trim();
}

function codexCommandOutcome(itemRaw) {
  const rawStatus = String(itemRaw?.status || "").trim().toLowerCase();
  const rawExitCode = itemRaw?.exitCode ?? itemRaw?.exit_code;
  const exitCode = rawExitCode === null || rawExitCode === undefined ? null : Number(rawExitCode);
  return {
    status: ["failed", "declined", "cancelled", "canceled"].includes(rawStatus) ||
      (Number.isFinite(exitCode) && exitCode !== 0)
      ? "failed"
      : "completed",
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
  };
}

function codexRecoveryTurn(threadResult) {
  const thread = threadResult?.thread || threadResult;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turns.at(-1) || thread?.activeTurn || thread?.turn || null;
  const status = String(turn?.status || thread?.status || "").trim().toLowerCase().replace(/[-\s]/g, "");
  return { turnId: String(turn?.id || "").trim(), status };
}

function isCompactItem(item) {
  const type = String(item?.type || "").trim().toLowerCase().replace(/[_-]/g, "");
  return ["compact", "compaction", "threadcompaction", "contextcompaction", "compacted"].includes(type);
}

function codexThreadLiveStatus(params) {
  const raw = firstNonEmptyString(
    params?.status?.type, params?.status?.state,
    params?.status, params?.state, params?.phase,
    params?.thread?.status, params?.thread?.state,
  ).toLowerCase().replace(/[-\s]/g, "");
  if (["idle", "ready", "completed", "complete", "done", "succeeded", "success"].includes(raw)) return "idle";
  if (["active", "running", "busy", "processing", "working", "compacting", "inprogress", "in_progress", "starting", "queued"].includes(raw)) return "active";
  return "";
}

export function createCodexBackend({
  createClient,
  resolveSessionCwd,
  listSessions,
  listSessionsForDirectories,
  readHistory,
  getStatus,
  listModels,
  dynamicTools = null,
  developerInstructions = "",
  generateActionId = () => `codex_action_${randomUUID()}`,
  clientName = "private-runner-agent",
  compactTimeoutMs = 10 * 60 * 1000,
  resolveNativeActiveSession = () => null,
  onActiveSessionsChanged,
} = {}) {
  if (typeof createClient !== "function") throw new TypeError("createClient is required");
  if (typeof resolveSessionCwd !== "function") throw new TypeError("resolveSessionCwd is required");
  const loadModels = typeof listModels === "function"
    ? listModels
    : () => listCodexModelsFromAppServer(createClient, clientName);
  const activeRuns = new Map();
  // Remember the last observed cumulative total to ignore stale usage snapshots
  // when a later turn starts on the same thread.
  const knownThreadOutputTokens = new Map();
  // app-serverがturn実行中のclient接続へbroadcastするthread/status/changedから、
  // 「native activeなthread」を追跡する。runner自身が起動したturn以外(spawnされた
  // subagent thread等)のactive/idleはここでしか観測できず、session一覧の
  // isActive(サブエージェント実行中数の表示源)に使う。
  const nativeActiveThreads = new Map();
  let openTurnClientCount = 0;
  const observeNativeThreadStatus = (method, params) => {
    if (method !== "thread/status/changed") return;
    const threadId = getCodexTurnEventIdentity(params).threadId;
    if (!threadId) return;
    const status = codexThreadLiveStatus(params);
    if (status === "active") {
      if (nativeActiveThreads.has(threadId)) return;
      const pending = Promise.resolve().then(() => resolveNativeActiveSession(threadId));
      nativeActiveThreads.set(threadId, pending);
      void pending.then((identity) => {
        if (nativeActiveThreads.get(threadId) !== pending) return;
        nativeActiveThreads.set(threadId, identity);
        onActiveSessionsChanged?.();
      }).catch(() => {
        if (nativeActiveThreads.get(threadId) === pending) nativeActiveThreads.set(threadId, null);
      });
    } else if (status === "idle" && nativeActiveThreads.delete(threadId)) onActiveSessionsChanged?.();
  };
  const releaseTurnClient = () => {
    openTurnClientCount = Math.max(0, openTurnClientCount - 1);
    // 通知を聴く接続が無くなったらactiveの根拠も消える。stale activeを
    // 残すと一覧が「実行中」を出し続けるため、知らない=idleへ倒す。
    if (openTurnClientCount === 0 && nativeActiveThreads.size > 0) {
      nativeActiveThreads.clear();
      onActiveSessionsChanged?.();
    }
  };
  const withNativeThreadActivity = (sessions) => (Array.isArray(sessions) ? sessions : []).map((session) => {
    const threadId = String(session?.sessionRef?.nativeSessionId || "");
    if (!nativeActiveThreads.has(threadId)) return session;
    const identity = nativeActiveThreads.get(threadId);
    if ((!identity || typeof identity.then === "function") && session.canonicalCwd) {
      nativeActiveThreads.set(threadId, { sessionRef: session.sessionRef,
        canonicalCwd: session.canonicalCwd,
        isSubagent: session.isSubagent === true || Boolean(session.parentSessionRef) });
      onActiveSessionsChanged?.();
    }
    return { ...session, isActive: true };
  });

  async function startTurn({ runId, sessionRef, cwd, input, model, effort, policyProfileId, signal, resolveSession, emit }) {
    if (signal?.aborted) {
      const error = new Error("Codex turn was interrupted before start");
      error.nativeActivity = "not_started";
      throw error;
    }
    const client = createClient({});
    const state = {
      client,
      emit,
      threadId: String(sessionRef?.nativeSessionId || "").trim(),
      turnId: "",
      actionById: new Map(),
      itemIds: new Set(),
      commandByToolCallId: new Map(),
      bufferedNotifications: [],
      turnStartRequested: false,
      outputTokens: 0,
      outputTokenBaseline: undefined,
      hasMeasuredOutputTokens: false,
      hasCurrentTurnItem: false,
    };
    const resumesExistingThread = Boolean(state.threadId);
    const priorThreadOutputTokens = state.threadId
      ? knownThreadOutputTokens.get(state.threadId)
      : undefined;
    activeRuns.set(runId, state);
    const emitItemStarted = (itemId, itemType = "assistant") => {
      if (!itemId || state.itemIds.has(itemId)) return;
      state.itemIds.add(itemId);
      emit("item.started", { itemId, itemType });
    };
    const emitToolStarted = (toolCallId, commandRaw) => {
      if (!toolCallId || state.commandByToolCallId.has(toolCallId)) return;
      const command = String(commandRaw || "").trim();
      state.commandByToolCallId.set(toolCallId, command);
      emit("tool.started", {
        toolCallId,
        name: "exec_command",
        inputSummary: command,
      });
    };
    const applyNotification = (method, params) => {
      if (!state.turnId) {
        state.bufferedNotifications.push({ method, params });
        return;
      }
      if (method === "serverRequest/resolved") {
        if (String(params?.threadId || "") !== state.threadId) return;
        for (const action of state.actionById.values()) {
          if (action.kind === "user_input" && String(action.request.id) === String(params?.requestId)) {
            action.finish({ answers: {} }, "cancelled");
          }
        }
        return;
      }
      if (!codexTurnEventMatches(params, { threadId: state.threadId, turnId: state.turnId })) return;
      if (method.startsWith("item/")) state.hasCurrentTurnItem = true;
      if (method === "thread/tokenUsage/updated") {
        const tokenUsage = params?.tokenUsage;
        const totalOutput = tokenUsage?.total?.outputTokens;
        let measuredOutput;
        if (Number.isSafeInteger(totalOutput) && totalOutput >= 0) {
          if (state.outputTokenBaseline === undefined && state.hasCurrentTurnItem &&
            (priorThreadOutputTokens === undefined || totalOutput > priorThreadOutputTokens)) {
            const lastOutput = tokenUsage?.last?.outputTokens;
            if (Number.isSafeInteger(lastOutput) && lastOutput >= 0 && totalOutput >= lastOutput) {
              state.outputTokenBaseline = totalOutput - lastOutput;
            }
          }
          if (totalOutput > (knownThreadOutputTokens.get(state.threadId) ?? -1)) {
            knownThreadOutputTokens.set(state.threadId, totalOutput);
          }
          if (state.outputTokenBaseline !== undefined && totalOutput >= state.outputTokenBaseline) {
            const nextOutputTokens = totalOutput - state.outputTokenBaseline;
            if (!state.hasMeasuredOutputTokens || nextOutputTokens !== state.outputTokens) {
              state.outputTokens = nextOutputTokens;
              state.hasMeasuredOutputTokens = true;
              measuredOutput = nextOutputTokens;
            }
          } else {
            state.outputTokenBaseline = undefined;
            state.hasMeasuredOutputTokens = false;
          }
        }
        emit("usage.updated", {
          ...(tokenUsage?.last && typeof tokenUsage.last === "object" ? {
            usage: { ...tokenUsage.last, contextWindowTokens: tokenUsage.modelContextWindow },
          } : {}),
          ...(measuredOutput !== undefined ? { outputTokens: measuredOutput } : {}),
        });
        return;
      }
      if (method === "turn/completed" || method === "turn/interrupted") {
        state.terminalNotification = { method, params };
        return;
      }
      if (method === "turn/started") return;
      if (method === "item/agentMessage/delta") {
        const itemId = codexItemId(params, `${state.turnId}:assistant`);
        emitItemStarted(itemId);
        emit("content.delta", {
          itemId,
          contentIndex: Number.isInteger(params?.contentIndex) ? params.contentIndex : 0,
          delta: String(params?.delta || ""),
        });
        return;
      }
      if (method === "item/started") {
        const itemId = codexItemId(params, "");
        const nativeItemType = String(params?.item?.type || "");
        if (nativeItemType === "commandExecution") {
          emitToolStarted(itemId, codexCommandText(params.item));
          return;
        }
        const itemType = nativeItemType === "agentMessage" ? "assistant" : (nativeItemType || "item");
        if (itemId) emitItemStarted(itemId, itemType);
        return;
      }
      if (method === "item/completed") {
        const nativeItemType = String(params?.item?.type || "");
        const itemId = codexItemId(params, `${state.turnId}:${nativeItemType || "item"}`);
        if (nativeItemType === "commandExecution") {
          const command = codexCommandText(params.item) || String(state.commandByToolCallId.get(itemId) || "");
          emitToolStarted(itemId, command);
          emit("tool.completed", {
            toolCallId: itemId,
            name: "exec_command",
            inputSummary: command,
            ...codexCommandOutcome(params.item),
          });
          return;
        }
        const itemType = nativeItemType === "agentMessage" ? "assistant" : (nativeItemType || "item");
        emitItemStarted(itemId, itemType);
        const text = nativeItemType === "agentMessage"
          ? extractCodexAgentMessageText(params.item)
          : "";
        emit("item.completed", {
          itemId,
          itemType,
          snapshotRevision: 1,
          ...(text ? { content: [{ type: "text", text }] } : {}),
        });
      }
    };
    const announceAction = (requestId, action) => {
      if (action.announced || !state.turnId) return;
      if (action.kind === "user_input" &&
        !codexTurnEventMatches(action.request.params, { threadId: state.threadId, turnId: state.turnId })) {
        action.finish({ answers: {} }, "cancelled");
        return;
      }
      action.announced = true;
      emit("action.requested", {
        requestId,
        kind: action.kind || "approval",
        title: action.title,
        decisions: action.decisions,
        ...(action.startedAtMs !== undefined ? { startedAtMs: action.startedAtMs } : {}),
        ...(action.request ? {
          input: { method: action.request.method, params: action.request.params },
        } : {}),
      });
    };
    openTurnClientCount += 1;
    const removeNativeStatusListener = client.addNotificationListener(observeNativeThreadStatus);
    const removeNotificationListener = client.addNotificationListener(applyNotification);
    const removeServerRequestHandler = client.addServerRequestHandler((request) => {
      if (request?.method === "item/tool/requestUserInput") {
        const requestId = generateActionId();
        return new Promise((resolve) => {
          const action = {
            kind: "user_input",
            announced: false,
            decisions: ["result"],
            title: "Question",
            request,
            startedAtMs: Date.now(),
            finish(result, outcome) {
              if (state.actionById.get(requestId) !== action) return;
              state.actionById.delete(requestId);
              clearTimeout(action.timer);
              resolve(result);
              if (action.announced) emit("action.resolved", { requestId, outcome });
            },
          };
          state.actionById.set(requestId, action);
          action.timer = setTimeout(() => action.finish({ answers: {} }, "expired"), 60_000);
          announceAction(requestId, action);
        });
      }
      if (String(request?.method || "") === "item/tool/call" && dynamicTools) {
        const requestId = generateActionId();
        return new Promise((resolve) => {
          const action = {
            resolve,
            announced: false,
            kind: "dynamic_tool",
            decisions: ["result"],
            title: String(request?.params?.tool || "Tool call"),
            request,
          };
          state.actionById.set(requestId, action);
          announceAction(requestId, action);
        });
      }
      if (!String(request?.method || "").endsWith("requestApproval")) {
        return { decision: "decline" };
      }
      const requestId = generateActionId();
      const method = String(request?.method || "");
      return new Promise((resolve) => {
        const action = {
          resolve,
          announced: false,
          decisions: method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
            ? ["allow", "allow_for_session", "deny"]
            : ["allow", "deny"],
          title: String(request?.params?.reason || request?.params?.item?.type || "Approval required"),
        };
        state.actionById.set(requestId, action);
        announceAction(requestId, action);
      });
    });
    try {
      const completion = client.waitForTurnCompletion();
      const started = await startCodexTurn({
        client,
        clientName,
        threadId: state.threadId,
        input,
        cwd,
        model,
        effort,
        approvalPolicy: policyProfileId === "codex-never" ? "never" : "on-request",
        dynamicTools,
        enableUserInput: true,
        developerInstructions,
        onBeforeTurnStart: () => { state.turnStartRequested = true; },
        onThreadResolved: sessionRef ? undefined : async ({ threadId }) => {
          state.threadId = threadId;
          await resolveSession({ backendId: "codex", nativeSessionId: threadId });
        },
      });
      state.threadId = started.threadId;
      if (!resumesExistingThread) state.outputTokenBaseline = 0;
      state.turnId = started.turnId;
      completion?.expect?.({ threadId: state.threadId, turnId: state.turnId });
      emit("turn.started", { nativeTurnId: state.turnId });
      // turnId確定後はliveの通知が直接applyされるため、bufferedのflushはawaitを
      // 挟む前に行う。interrupt要求のawait中にliveが先に適用されると順序が崩れる。
      for (const [requestId, action] of state.actionById) announceAction(requestId, action);
      for (const notification of state.bufferedNotifications.splice(0)) {
        applyNotification(notification.method, notification.params);
      }
      if (signal?.aborted) {
        await client.request("turn/interrupt", {
          threadId: state.threadId,
          turnId: state.turnId,
        }, 5000).catch(() => {});
      }
      await (completion?.promise || completion);
      const terminal = state.terminalNotification;
      const status = codexTurnStatus(terminal?.params);
      // context length表示の更新源。raw経路のturn/completed usage抽出と同じ情報を
      // neutralイベントとしても届ける。
      const turnUsage = codexTurnCompletedUsage(terminal?.params);
      if (turnUsage) {
        emit("usage.updated", { usage: turnUsage });
      }
      if (terminal?.method === "turn/interrupted" || INTERRUPTED_TURN_STATUSES.has(status)) {
        return { outcome: "interrupted" };
      }
      if (terminal?.method !== "turn/completed" || !SUCCESSFUL_TURN_STATUSES.has(status)) {
        const error = new Error(String(terminal?.params?.turn?.error?.message || "Codex turn ended without completing"));
        if (terminal?.params?.turn?.error?.codexErrorInfo === "usageLimitExceeded") error.code = "usage_limit_exceeded";
        if (terminal?.method === "turn/completed") error.nativeActivity = "stopped";
        throw error;
      }
      return { outcome: "completed" };
    } catch (error) {
      if (!state.turnStartRequested && error && typeof error === "object" && !error.nativeActivity) {
        error.nativeActivity = "not_started";
      }
      throw error;
    } finally {
      for (const action of state.actionById.values()) {
        if (action.kind === "user_input") {
          action.finish({ answers: {} }, "cancelled");
          continue;
        }
        action.resolve(action.kind === "dynamic_tool"
          ? { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code: "request_cancelled", message: "The tool request was cancelled.", retryable: false } }) }] }
          : { decision: "decline" });
      }
      state.actionById.clear();
      removeNativeStatusListener();
      removeNotificationListener();
      removeServerRequestHandler();
      client.close();
      releaseTurnClient();
      activeRuns.delete(runId);
    }
  }

  async function compactSession({ sessionRef }) {
    const threadId = String(sessionRef?.nativeSessionId || "").trim();
    const client = createClient({});
    let method = "thread/compact/start";
    let sawActivity = false;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    let timer = null;
    const removeListener = client.addNotificationListener((notificationMethod, params) => {
      const eventThreadId = getCodexTurnEventIdentity(params).threadId;
      if (eventThreadId && eventThreadId !== threadId) return;
      if (notificationMethod === "thread/compacted") return resolveCompletion();
      if (notificationMethod === "thread/status/changed") {
        const status = codexThreadLiveStatus(params);
        if (status === "active") sawActivity = true;
        else if (status === "idle" && sawActivity) resolveCompletion();
      } else if (notificationMethod === "item/started" && isCompactItem(params?.item)) {
        sawActivity = true;
      } else if (notificationMethod === "item/completed" && isCompactItem(params?.item)) {
        resolveCompletion();
      } else if (notificationMethod === "turn/completed" && sawActivity) {
        resolveCompletion();
      }
    });
    let compactStarted = false;
    try {
      await initializeCodexClient(client, `${clientName}-compact`);
      await client.request("thread/read", { threadId, includeTurns: false }, 30000)
        .catch(() => client.request("thread/resume", { threadId }, 30000));
      await client.request("thread/resume", { threadId }, 30000);
      try {
        compactStarted = true;
        await client.request(method, { threadId }, 30000);
      } catch (error) {
        if (!/method[^\n]*(not found|unsupported)|unknown method/i.test(String(error?.message || ""))) throw error;
        method = "thread/compact";
        compactStarted = false;
        await client.request(method, { threadId }, compactTimeoutMs);
        return { sessionRef, method, accepted: true };
      }
      const timedOut = await Promise.race([
        completion.then(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(true), compactTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timedOut) throw new Error("Codex compact completion timed out");
      return { sessionRef, method, accepted: true };
    } catch (error) {
      if (error && typeof error === "object") error.nativeActivity = compactStarted ? "unknown" : "not_started";
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      removeListener();
      client.close();
    }
  }

  return {
    backendId: "codex",
    listActiveSessions: () => [...nativeActiveThreads.values()].filter((value) => value?.sessionRef),
    defaultDiscoveredSessionMode: "raw",
    getStatus: getStatus || (async () => {
      let catalog;
      try {
        catalog = await loadModels();
      } catch (error) {
        return {
          backendId: "codex",
          available: false,
          auth: { state: "unknown" },
          readiness: {
            ready: false,
            reason: error instanceof Error ? error.message : String(error || "Codex model catalog is unavailable"),
          },
        };
      }
      return {
        backendId: "codex",
        available: true,
        auth: { state: "unknown" },
        readiness: { ready: true },
        capabilities: {
          session: { resume: true, list: true, history: { read: true, delta: true } },
          turn: { interrupt: true },
          action: {
            kinds: dynamicTools ? ["approval", "dynamic_tool"] : ["approval"],
            decisions: dynamicTools
              ? ["allow", "allow_for_session", "deny", "result"]
              : ["allow", "allow_for_session", "deny"],
            policyProfiles: [
              { id: "codex-on-request", label: "On request", interactive: true, decisions: ["allow", "allow_for_session", "deny"] },
              { id: "codex-never", label: "Never", interactive: false, decisions: [] },
            ],
          },
          permission: { interactive: true },
          model: { select: true, effort: true, effortOptions: CODEX_EFFORT_OPTIONS, catalog },
          workspace: { projectCustomizations: true, admission: false },
          operations: { compact: true, schedule: true },
          event: { nativePayload: false },
          tool: { dynamic: Boolean(dynamicTools) },
        },
      };
    }),
    startTurn,
    resolveSessionCwd,
    listSessions: typeof listSessions === "function"
      ? async (options) => {
        const page = await listSessions(options);
        return { ...page, sessions: withNativeThreadActivity(page?.sessions) };
      }
      : listSessions,
    listSessionsForDirectories: typeof listSessionsForDirectories === "function"
      ? async (options) => {
        const result = await listSessionsForDirectories(options);
        return {
          ...result,
          groups: (Array.isArray(result?.groups) ? result.groups : []).map((group) => ({
            ...group,
            sessions: withNativeThreadActivity(group?.sessions),
          })),
        };
      }
      : listSessionsForDirectories,
    readHistory,
    listModels: loadModels,
    compactSession,
    async interrupt({ runId }) {
      const state = activeRuns.get(runId);
      if (!state) return;
      if (state.threadId && state.turnId) {
        await state.client.request("turn/interrupt", {
          threadId: state.threadId,
          turnId: state.turnId,
        }, 5000).catch(() => {});
      } else if (!state.turnStartRequested) {
        state.client.close(1000, "interrupted_before_turn_start");
      }
    },
    async respondToAction({ runId, requestId, decision, result }) {
      const state = activeRuns.get(runId);
      const action = state?.actionById.get(requestId);
      if (!action) throw new Error("Codex approval expired");
      if (action.kind === "user_input") {
        if (Date.now() >= action.startedAtMs + 60_000) {
          action.finish({ answers: {} }, "expired");
          const error = new Error("Codex question expired");
          error.code = "action_expired";
          throw error;
        }
        if (decision !== "result" || !isValidUserInputResponse(action.request.params, result)) {
          throw new Error("Invalid Codex question answers");
        }
        const answers = result.answers;
        action.finish({ answers }, Object.keys(answers).length ? "completed" : "skipped");
        return;
      }
      state.actionById.delete(requestId);
      action.resolve(action.kind === "dynamic_tool"
        ? result
        : { decision: decision === "allow_for_session" ? "acceptForSession" : decision === "allow" ? "accept" : "decline" });
      state.emit("action.resolved", {
        requestId,
        outcome: action.kind === "dynamic_tool"
          ? "completed"
          : decision === "allow" || decision === "allow_for_session" ? "allowed" : "denied",
        ...(action.kind === "dynamic_tool" ? {} : { decision }),
      });
    },
    async recoverSession({ sessionRef }) {
      const client = createClient({});
      try {
        await initializeCodexClient(client, `${clientName}-recovery`);
        const threadId = String(sessionRef?.nativeSessionId || "").trim();
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const read = await client.request("thread/read", { threadId, includeTurns: true }, 30000);
          const turn = codexRecoveryTurn(read);
          if (!turn.status || STOPPED_TURN_STATUSES.has(turn.status)) return { nativeActivity: "stopped" };
          if (!ACTIVE_TURN_STATUSES.has(turn.status) || !turn.turnId) return { nativeActivity: "unknown" };
          if (attempt === 0) {
            await client.request("turn/interrupt", { threadId, turnId: turn.turnId }, 5000).catch(() => {});
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { nativeActivity: "unknown" };
      } catch {
        return { nativeActivity: "unknown" };
      } finally {
        client.close();
      }
    },
    async close() {
      for (const state of activeRuns.values()) state.client.close(1001, "backend closed");
      activeRuns.clear();
    },
  };
}

export async function executeCodexTurn(options) {
  const { client } = options;
  if (typeof client?.addNotificationListener !== "function") {
    throw new Error("client.addNotificationListener is required");
  }

  let lastAgentMessageText = "";
  let turnCompleted = false;
  let turnError;
  let expectedThreadId = "";
  let expectedTurnId = "";
  const notificationsBeforeTurnStarted = [];
  const applyOwnedNotification = (method, params) => {
    if (!codexTurnEventMatches(params, { threadId: expectedThreadId, turnId: expectedTurnId })) return;
    if (method === "turn/completed") {
      const status = String(params?.turn?.status || params?.status || "").trim().toLowerCase();
      turnCompleted = SUCCESSFUL_TURN_STATUSES.has(status);
      turnError = params?.turn?.error;
      return;
    }
    if (method === "item/agentMessage/delta") {
      lastAgentMessageText += String(params?.delta || "");
      return;
    }
    if (method !== "item/completed" || String(params?.item?.type || "").trim() !== "agentMessage") return;
    const completedText = extractCodexAgentMessageText(params.item);
    if (completedText) lastAgentMessageText = completedText;
  };
  const removeNotificationListener = client.addNotificationListener((method, params) => {
    if (!expectedTurnId) {
      notificationsBeforeTurnStarted.push({ method, params });
      return;
    }
    applyOwnedNotification(method, params);
  });
  try {
    const completion = client.waitForTurnCompletion();
    const started = await startCodexTurn(options);
    expectedThreadId = started.threadId;
    expectedTurnId = started.turnId;
    completion?.expect?.({ threadId: expectedThreadId, turnId: expectedTurnId });
    for (const notification of notificationsBeforeTurnStarted.splice(0)) {
      applyOwnedNotification(notification.method, notification.params);
    }
    await (completion?.promise || completion);
    if (!turnCompleted) {
      const error = new Error(String(turnError?.message || "Codex turn ended without completing"));
      if (turnError?.codexErrorInfo === "usageLimitExceeded") error.code = "usage_limit_exceeded";
      throw error;
    }
    return { threadId: expectedThreadId, turnId: expectedTurnId, lastAgentMessageText };
  } finally {
    removeNotificationListener();
  }
}
