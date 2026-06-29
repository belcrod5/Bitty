import {
  createWebSocketWithOptionalAuth,
  extractNotificationMessage,
  firstString,
  isRpcMethodNotFoundError,
  isThreadNotFoundError,
  normalizeCodexWsInputs,
  parseJsonRpcMessage,
  parseNotificationThreadId,
  toErrorMessage,
} from "./helpers";
import {
  COMPACT_ASYNC_COMPLETION_TIMEOUT_MS,
  NEAR_UNLIMITED_TIMEOUT_MS,
  type CodexThreadCompactResult,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcSuccess,
  type PendingRequest,
} from "./types";
import {
  encodeRunnerWsLlmRpc,
  isRunnerWsUrl,
  normalizeRunnerWsIncomingCodexRpc,
} from "../../runnerWs/llmAdapter";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import {
  buildCodexRunnerWsRequestId,
  CodexRunnerWsJsonRpcIdMapper,
  createCodexRunnerWsLogicalId,
} from "./runnerWsJsonRpcIds";

function isCompactItem(itemRaw: unknown) {
  if (!itemRaw || typeof itemRaw !== "object") return false;
  const type = String((itemRaw as Record<string, unknown>).type || "").trim().toLowerCase();
  return (
    type === "compact" ||
    type === "compaction" ||
    type === "threadcompaction" ||
    type === "thread_compaction" ||
    type === "contextcompaction" ||
    type === "context_compaction" ||
    type === "compacted"
  );
}

function parseCompactThreadStatus(paramsRaw: unknown): "active" | "idle" | "" {
  if (!paramsRaw || typeof paramsRaw !== "object") return "";
  const params = paramsRaw as Record<string, unknown>;
  const readStatusText = (raw: unknown) => {
    if (typeof raw === "string" || typeof raw === "number") {
      return String(raw).trim().toLowerCase();
    }
    if (!raw || typeof raw !== "object") return "";
    const obj = raw as Record<string, unknown>;
    return firstString(obj.type, obj.status, obj.state, obj.phase, obj.value, obj.name)
      .toLowerCase();
  };
  const status = [
    params.status,
    params.state,
    params.phase,
    (params as any)?.thread?.status,
    (params as any)?.thread?.state,
    (params as any)?.turn?.status,
    (params as any)?.turn?.state,
  ].map(readStatusText).find(Boolean) || "";
  if (["idle", "ready", "completed", "complete", "done", "succeeded", "success"].includes(status)) {
    return "idle";
  }
  if (["active", "running", "busy", "processing", "working", "compacting", "inprogress", "in_progress", "starting", "queued"].includes(status)) {
    return "active";
  }
  return "";
}

export async function compactCodexAppServerThread(options: {
  wsUrl: string;
  wsToken?: string;
  threadId: string;
  timeoutMs?: number;
  onLog?: (entry: {
    stage: string;
    method?: string;
    id?: number;
    readyState?: number;
    message?: string;
  }) => void;
  onEvent?: (method: string, params: unknown) => void;
  runnerWebSocketManager?: RunnerWebSocketManager;
}): Promise<CodexThreadCompactResult> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const runnerWebSocketManager = options.runnerWebSocketManager;
  const useRunnerWsManager = Boolean(runnerWebSocketManager);
  const useRunnerWsEnvelope = useRunnerWsManager || isRunnerWsUrl(wsUrl);
  const wsToken = normalized.wsToken;
  const threadId = String(options.threadId || "").trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");
  if (!threadId) throw new Error("threadId is empty");

  const ws = useRunnerWsManager ? null : createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;
  const pending = new Map<JsonRpcId, PendingRequest>();
  const runnerWsOperationId = createCodexRunnerWsLogicalId("codex_compact_op", threadId);
  const runnerWsSessionId = threadId;
  const runnerWsRpcIds = new CodexRunnerWsJsonRpcIdMapper();
  const managerUnsubscribers: Array<() => void> = [];
  let runnerWsEnvelopeSeq = 0;
  let nextId = 1;
  let finalized = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let asyncCompletionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let waitingForAsyncCompact = false;
  let sawAsyncCompactActivity = false;

  function emitLog(entry: {
    stage: string;
    method?: string;
    id?: number;
    readyState?: number;
    message?: string;
  }) {
    if (!options.onLog) return;
    try {
      options.onLog(entry);
    } catch {}
  }

  function emitEvent(method: string, params: unknown) {
    if (!options.onEvent) return;
    try {
      options.onEvent(method, params);
    } catch {}
  }

  function cleanup() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (asyncCompletionTimeoutHandle) {
      clearTimeout(asyncCompletionTimeoutHandle);
      asyncCompletionTimeoutHandle = null;
    }
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server request cancelled"));
    }
    pending.clear();
    runnerWsRpcIds.clear();
    while (managerUnsubscribers.length > 0) {
      const unsubscribe = managerUnsubscribers.pop();
      try {
        unsubscribe?.();
      } catch {}
    }
    if (useRunnerWsManager) return;
    try {
      if (ws && (getTransportReadyState() === WebSocket.OPEN || getTransportReadyState() === WebSocket.CONNECTING)) {
        ws.close();
      }
    } catch {}
  }

  function getTransportReadyState() {
    if (useRunnerWsManager && runnerWebSocketManager) {
      return runnerWebSocketManager.getSnapshot().readyState;
    }
    return ws?.readyState ?? WebSocket.CLOSED;
  }

  function sendJson(payload: Record<string, unknown>) {
    const id = Number(payload.id);
    const method = String(payload.method || "");
    emitLog({
      stage: "rpc_send",
      method: method || undefined,
      id: Number.isFinite(id) ? id : undefined,
      readyState: getTransportReadyState(),
    });
    if (useRunnerWsManager && runnerWebSocketManager) {
      runnerWsEnvelopeSeq += 1;
      runnerWebSocketManager.send({
        channel: "llm",
        op: "rpc",
        requestId: buildCodexRunnerWsRequestId(
          runnerWsOperationId,
          runnerWsEnvelopeSeq,
          method,
          id
        ),
        operationId: runnerWsOperationId,
        sessionId: runnerWsSessionId,
        threadId,
        payload: runnerWsRpcIds.rewriteOutbound(payload),
      });
      return;
    }
    if (!ws) throw new Error("Codex app-server WebSocket is not initialized");
    ws.send(useRunnerWsEnvelope
      ? encodeRunnerWsLlmRpc(payload, threadId)
      : JSON.stringify(payload));
  }

  function sendRequest<R>(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++;
    return new Promise<R>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        sendJson({
          id,
          method,
          params,
        });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
      }
    });
  }

  function resolvePendingForId(idRaw: unknown, result: unknown) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    emitLog({
      stage: "rpc_result",
      id,
      readyState: getTransportReadyState(),
    });
    pendingEntry.resolve(result);
  }

  function rejectPendingForId(idRaw: unknown, message: string) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    emitLog({
      stage: "rpc_error",
      id,
      message,
      readyState: getTransportReadyState(),
    });
    pendingEntry.reject(new Error(message));
  }

  return await new Promise<CodexThreadCompactResult>((resolve, reject) => {
    function fail(error: unknown) {
      if (finalized) return;
      finalized = true;
      emitLog({
        stage: "compact_fail",
        message: toErrorMessage(error),
        readyState: getTransportReadyState(),
      });
      cleanup();
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }

    function succeed(method: "thread/compact/start" | "thread/compact", message = "completed") {
      if (finalized) return;
      finalized = true;
      emitLog({
        stage: "compact_success",
        method,
        message,
        readyState: getTransportReadyState(),
      });
      cleanup();
      resolve({
        threadId,
        method,
        accepted: true,
      });
    }

    function waitForAsyncCompactCompletion() {
      waitingForAsyncCompact = true;
      if (asyncCompletionTimeoutHandle) {
        clearTimeout(asyncCompletionTimeoutHandle);
      }
      asyncCompletionTimeoutHandle = setTimeout(() => {
        fail(
          new Error(
            `Codex app-server compact async completion timeout (${COMPACT_ASYNC_COMPLETION_TIMEOUT_MS}ms)`
          )
        );
      }, COMPACT_ASYNC_COMPLETION_TIMEOUT_MS);
      emitLog({
        stage: "compact_async_wait_started",
        method: "thread/compact/start",
        message: `timeoutMs=${COMPACT_ASYNC_COMPLETION_TIMEOUT_MS}`,
        readyState: getTransportReadyState(),
      });
    }

    function stopAsyncCompactCompletionWait() {
      waitingForAsyncCompact = false;
      sawAsyncCompactActivity = false;
      if (asyncCompletionTimeoutHandle) {
        clearTimeout(asyncCompletionTimeoutHandle);
        asyncCompletionTimeoutHandle = null;
      }
    }

    function isTargetThreadNotification(params: unknown) {
      const eventThreadId = parseNotificationThreadId(params);
      return !eventThreadId || eventThreadId === threadId;
    }

    function handleAsyncCompactNotification(method: string, params: unknown) {
      if (!waitingForAsyncCompact || !isTargetThreadNotification(params)) return;
      if (method === "thread/compacted") {
        succeed("thread/compact/start", "thread_compacted");
        return;
      }
      if (method === "thread/status/changed") {
        const status = parseCompactThreadStatus(params);
        if (status === "active") {
          sawAsyncCompactActivity = true;
        } else if (status === "idle" && sawAsyncCompactActivity) {
          succeed("thread/compact/start", "thread_idle_after_activity");
        }
        return;
      }
      if (method === "item/started" && isCompactItem((params as any)?.item)) {
        sawAsyncCompactActivity = true;
        return;
      }
      if (method === "item/completed" && isCompactItem((params as any)?.item)) {
        succeed("thread/compact/start", "compact_item_completed");
        return;
      }
      if (method === "turn/completed" && sawAsyncCompactActivity) {
        succeed("thread/compact/start", "turn_completed_after_activity");
      }
    }

    timeoutHandle = setTimeout(() => {
      fail(new Error(`Codex app-server compact timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    async function runCompactSession() {
        await sendRequest("initialize", {
          clientInfo: {
            name: "expo-ios-thread-compact",
            title: "Expo iOS Thread Compact",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: [],
          },
        });
        sendJson({ method: "initialized", params: {} });

        async function ensureThreadReachable() {
          try {
            const readResult = await sendRequest<Record<string, unknown>>("thread/read", {
              threadId,
              includeTurns: false,
            });
            const readThreadId = firstString(
              (readResult as any)?.thread?.id,
              (readResult as any)?.thread?.threadId,
              (readResult as any)?.threadId
            );
            if (!readThreadId || readThreadId !== threadId) {
              throw new Error(`thread not found: ${threadId}`);
            }
            emitLog({
              stage: "compact_thread_check_ok",
              method: "thread/read",
              readyState: getTransportReadyState(),
            });
            return;
          } catch (readError) {
            if (isRpcMethodNotFoundError(readError)) {
              emitLog({
                stage: "compact_thread_check_skip",
                method: "thread/read",
                message: "unsupported",
                readyState: getTransportReadyState(),
              });
              return;
            }
            if (!isThreadNotFoundError(readError)) {
              throw readError;
            }
            emitLog({
              stage: "compact_thread_check_retry",
              method: "thread/resume",
              message: "thread_not_found_on_read",
              readyState: getTransportReadyState(),
            });
            await sendRequest<Record<string, unknown>>("thread/resume", { threadId });
            emitLog({
              stage: "compact_thread_check_ok",
              method: "thread/resume",
              readyState: getTransportReadyState(),
            });
          }
        }

        let reachable = false;
        let lastReachableError: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            await ensureThreadReachable();
            reachable = true;
            break;
          } catch (error) {
            lastReachableError = error;
            if (!isThreadNotFoundError(error) || attempt >= 2) {
              throw error;
            }
            emitLog({
              stage: "compact_thread_check_retry_wait",
              message: `attempt=${attempt}`,
              readyState: getTransportReadyState(),
            });
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        if (!reachable && lastReachableError) {
          throw lastReachableError;
        }

        let resumedBeforeCompactStart = false;
        const methods: Array<"thread/compact/start" | "thread/compact"> = [
          "thread/compact/start",
          "thread/compact",
        ];
        let lastError: unknown = null;
        for (const method of methods) {
          let retriedAfterResume = false;
          try {
            while (true) {
              try {
                if (method === "thread/compact/start" && !resumedBeforeCompactStart) {
                  await sendRequest<Record<string, unknown>>("thread/resume", { threadId });
                  resumedBeforeCompactStart = true;
                  emitLog({
                    stage: "compact_thread_check_ok",
                    method: "thread/resume",
                    message: "before_compact_start",
                    readyState: getTransportReadyState(),
                  });
                }
                if (method === "thread/compact/start") {
                  waitForAsyncCompactCompletion();
                }
                await sendRequest<Record<string, unknown>>(method, { threadId });
                emitLog({
                  stage: "compact_method_selected",
                  method,
                  readyState: getTransportReadyState(),
                });
                if (method !== "thread/compact/start") {
                  succeed(method, "rpc_completed");
                }
                return;
              } catch (error) {
                lastError = error;
                if (method === "thread/compact/start") {
                  stopAsyncCompactCompletionWait();
                }
                if (isRpcMethodNotFoundError(error)) {
                  break;
                }
                if (method === "thread/compact/start" && !retriedAfterResume && isThreadNotFoundError(error)) {
                  retriedAfterResume = true;
                  emitLog({
                    stage: "compact_method_retry",
                    method,
                    message: "thread_not_found_retry_after_resume",
                    readyState: getTransportReadyState(),
                  });
                  await sendRequest<Record<string, unknown>>("thread/resume", { threadId });
                  emitLog({
                    stage: "compact_thread_check_ok",
                    method: "thread/resume",
                    message: "retry_before_compact_start",
                    readyState: getTransportReadyState(),
                  });
                  continue;
                }
                throw error;
              }
            }
          } catch (error) {
            lastError = error;
            if (isRpcMethodNotFoundError(error)) {
              continue;
            }
            throw error;
          }
        }
        throw (lastError instanceof Error
          ? lastError
          : new Error("thread compact is not supported by this codex app-server"));
    }

    function handleIncomingRawData(rawData: string) {
      if (finalized) return;
      const incoming = normalizeRunnerWsIncomingCodexRpc(rawData);
      if (incoming.type === "ignore") return;
      if (incoming.type === "error") {
        fail(new Error(incoming.message));
        return;
      }
      const message = parseJsonRpcMessage(incoming.rawData);
      if (!message) return;
      const rewrittenMessage = useRunnerWsManager ? runnerWsRpcIds.rewriteIncoming(message) : message;
      const id = rewrittenMessage.id;
      const hasId = typeof id !== "undefined";
      const method = rewrittenMessage.method;
      const methodText = String(method || "");

      if (hasId && typeof method === "undefined") {
        const payloadError = rewrittenMessage.error as JsonRpcFailure["error"] | undefined;
        if (payloadError) {
          const msg = String(payloadError.message || "json-rpc request failed");
          rejectPendingForId(id, msg);
          return;
        }
        resolvePendingForId(id, (rewrittenMessage as JsonRpcSuccess).result);
        return;
      }

      if (hasId && typeof method === "string") {
        emitLog({
          stage: "rpc_server_request_unsupported",
          method: methodText || undefined,
          id: Number.isFinite(Number(id)) ? Number(id) : undefined,
          readyState: getTransportReadyState(),
        });
        sendJson({
          id: id as any,
          error: {
            code: -32000,
            message: `${method} is not supported by this client`,
          },
        });
        return;
      }

      emitLog({
        stage: "notification",
        method: methodText || undefined,
        readyState: getTransportReadyState(),
      });
      emitEvent(methodText, rewrittenMessage.params);

      if (methodText === "error") {
        const messageText = extractNotificationMessage(rewrittenMessage.params);
        if (messageText) {
          fail(new Error(`Codex compact failed: ${messageText}`));
        }
        return;
      }
      handleAsyncCompactNotification(methodText, rewrittenMessage.params);
    }

    function startCompactSession() {
      runCompactSession().catch((error) => {
        fail(error);
      });
    }

    emitLog({
      stage: "ws_connect_start",
      readyState: getTransportReadyState(),
      message: useRunnerWsManager ? `${wsUrl} (manager)` : wsLabel,
    });

    if (useRunnerWsManager && runnerWebSocketManager) {
      let managerReadyObserved = runnerWebSocketManager.getSnapshot().connectionState === "ready";
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        {
          channel: "llm",
          op: "rpc",
          operationId: runnerWsOperationId,
          sessionId: runnerWsSessionId,
          threadId,
        },
        (message: RunnerWsMessage) => {
          handleIncomingRawData(JSON.stringify(message));
        }
      ));
      managerUnsubscribers.push(runnerWebSocketManager.subscribeSnapshot(() => {
        if (finalized || !managerReadyObserved) return;
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (snapshot.connectionState === "ready") return;
        fail(new Error(`Codex app-server runner-ws disconnected: state=${snapshot.connectionState}`));
      }));
      runnerWebSocketManager.connect()
        .then(() => {
          if (finalized) return;
          managerReadyObserved = true;
          emitLog({
            stage: "ws_open",
            readyState: getTransportReadyState(),
            message: "runner_ws_manager_ready",
          });
          startCompactSession();
        })
        .catch((error) => {
          fail(error);
        });
      return;
    }

    if (!ws) {
      fail(new Error("Codex app-server WebSocket is not initialized"));
      return;
    }

    ws.onopen = () => {
      emitLog({
        stage: "ws_open",
        readyState: getTransportReadyState(),
      });
      startCompactSession();
    };

    ws.onmessage = (event) => {
      const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
      handleIncomingRawData(rawData);
    };

    ws.onerror = (event: any) => {
      const detail = String(event?.message || event?.type || "unknown");
      emitLog({
        stage: "ws_error",
        message: detail,
        readyState: getTransportReadyState(),
      });
      fail(new Error(`Codex app-server WebSocket error: ${detail} url=${wsLabel} readyState=${getTransportReadyState()}`));
    };

    ws.onclose = (event: any) => {
      if (finalized) return;
      const code = Number(event?.code);
      const reason = String(event?.reason || "").trim();
      const wasClean = Boolean(event?.wasClean);
      const codeText = Number.isFinite(code) ? String(code) : "unknown";
      emitLog({
        stage: "ws_close",
        message: `code=${codeText} reason=${reason || "-"} clean=${wasClean}`,
        readyState: getTransportReadyState(),
      });
      fail(
        new Error(
          `Codex app-server WebSocket closed: code=${codeText} reason=${reason || "-"} clean=${wasClean} url=${wsLabel} readyState=${getTransportReadyState()}`
        )
      );
    };
  });
}
