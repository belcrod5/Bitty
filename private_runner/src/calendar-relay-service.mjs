import { calendarScheduleRequestId } from "./calendar-tool-service.mjs";

export function createCalendarRelayService({
  WebSocket,
  sendRelayControl,
  sendRunnerWsEnvelope,
  isEnvelopeClient,
  sendRpcToClient,
}) {
  const rpcIdKey = (id) => typeof id === "number" && Number.isFinite(id)
    ? `n:${id}`
    : (typeof id === "string" ? `s:${id}` : "");
  const toolName = (payload) => {
    if (String(payload?.method || "") !== "item/tool/call") return "";
    const tool = String(payload?.params?.tool || "").trim();
    return /^calendar_(list_calendars|search_events|get_event|create_event|update_event|delete_event)$/.test(tool) ? tool : "";
  };
  const dynamicItem = (payload) => {
    const item = payload?.params?.item;
    if (!item || typeof item !== "object") return false;
    const tool = String(item.toolName || item.tool?.name || item.tool || item.name || item.function?.name || "").trim();
    return String(item.type || "").toLowerCase() === "dynamictoolcall" && tool.startsWith("calendar_");
  };
  const error = (code) => ({
    ok: false,
    error: {
      code,
      message: {
        invalid_arguments: "入力内容が正しくありません。",
        device_unavailable: "カレンダー端末に接続できません。",
        foreground_required: "予定の変更はアプリを開いているときだけ実行できます。",
        result_unknown: "予定の変更結果を確認できません。自動再試行は行いません。",
        request_cancelled: "カレンダー要求はキャンセルされました。",
      }[code] || "カレンダーの操作に失敗しました。",
      retryable: false,
    },
  });
  const runnerInitiatedResponse = (request) => {
    const tool = toolName(request);
    if (!tool) return { success: false, contentItems: [] };
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(error(/_(create|update|delete)_event$/.test(tool) ? "foreground_required" : "device_unavailable")) }] };
  };
  const rememberClosed = (relay, id) => {
    const key = rpcIdKey(id);
    if (!key) return;
    if (!(relay.calendarClosedRpcIds instanceof Set)) relay.calendarClosedRpcIds = new Set();
    relay.calendarClosedRpcIds.add(key);
    if (relay.calendarClosedRpcIds.size > 512) relay.calendarClosedRpcIds.delete(relay.calendarClosedRpcIds.values().next().value);
  };
  const sendResponse = (relay, request, result) => {
    if (!relay?.upstreamOpen || relay.upstreamWs?.readyState !== WebSocket.OPEN) return;
    relay.upstreamWs.send(JSON.stringify({ id: request.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] } }));
  };
  const sendCancel = (request, reason) => {
    const owner = request.owner;
    if (!owner?.ws) return;
    const payload = {
      appServerRequestId: typeof request.id === "number" ? { type: "number", value: request.id } : { type: "string", value: request.id },
      turnId: request.turnId, requestId: request.requestId, reason,
    };
    if (!isEnvelopeClient(owner.ws)) {
      sendRelayControl(owner.ws, { type: "runner_relay_calendar_request_cancel", payload });
      return;
    }
    sendRunnerWsEnvelope(owner.ws, { channel: "relay", op: "calendar_request_cancel", operationId: owner.operationId, sessionId: owner.sessionId, threadId: owner.threadId, payload });
  };
  const terminate = (relay, request, reason) => {
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);
    relay.calendarRequests.delete(rpcIdKey(request.id));
    rememberClosed(relay, request.id);
    if (reason === "timeout" || reason === "interrupt") sendCancel(request, reason);
    const write = /_(create|update|delete)_event$/.test(request.tool);
    sendResponse(relay, request, error(reason === "owner_disconnect" ? (write ? "result_unknown" : "device_unavailable") : (reason === "interrupt" ? "request_cancelled" : (write ? "result_unknown" : "device_unavailable"))));
  };
  const setTurnOwner = (relay, owner) => { relay.calendarOwner = owner || null; };
  const terminateOwnerRequests = (relay, ws, reason = "owner_disconnect") => {
    if (relay.calendarOwner?.ws !== ws) return false;
    for (const request of Array.from(relay.calendarRequests?.values?.() || [])) terminate(relay, request, reason);
    relay.calendarOwner = null;
    return true;
  };
  const cleanupRelayState = (relay) => {
    for (const request of relay.calendarRequests?.values?.() || []) clearTimeout(request.timer);
    relay.calendarRequests?.clear?.();
    relay.calendarClosedRpcIds?.clear?.();
  };
  const handleUpstreamToolCall = (relay, payload, rawData) => {
    const tool = toolName(payload);
    if (!tool) return false;
    const owner = relay.calendarOwner;
    const requestKey = rpcIdKey(payload?.id);
    if (!requestKey || payload?.params?.namespace !== null) {
      sendResponse(relay, { id: payload?.id }, error("invalid_arguments"));
      return true;
    }
    if (!owner?.ws || !relay.clients.has(owner.ws)) {
      sendResponse(relay, { id: payload?.id }, error(
        /_(create|update|delete)_event$/.test(tool) ? "foreground_required" : "device_unavailable"
      ));
      return true;
    }
    if (relay.calendarRequests.has(requestKey)) {
      sendResponse(relay, { id: payload?.id }, error("invalid_arguments"));
      return true;
    }
    relay.calendarClosedRpcIds?.delete?.(requestKey);
    const turnId = String(payload?.params?.turnId || owner.turnId || "");
    const request = {
      id: payload.id,
      requestId: calendarScheduleRequestId([
        String(payload?.params?.threadId || owner.threadId || ""),
        turnId,
        String(payload?.params?.callId || ""),
        tool,
      ]),
      tool,
      owner: { ...owner, turnId },
      turnId,
      done: false,
      timer: null,
    };
    request.timer = setTimeout(
      () => terminate(relay, request, "timeout"),
      /_(create|update|delete)_event$/.test(tool) ? 125_000 : 30_000
    );
    relay.calendarRequests.set(requestKey, request);
    sendRpcToClient(relay, owner.ws, String(rawData), undefined, {
      operationId: owner.operationId,
      sessionId: owner.sessionId,
    });
    return true;
  };
  const handleClientResponse = (relay, payload, rawData, isBinary, client) => {
    const request = relay.calendarRequests?.get?.(rpcIdKey(payload?.id));
    if (request) {
      const owner = request.owner;
      const ownerMatches = owner?.ws === client.ws
        && owner.operationId === client.operationId
        && owner.sessionId === client.sessionId
        && owner.threadId === (client.threadId || owner.threadId)
        && (!client.turnId || owner.turnId === client.turnId);
      if (!ownerMatches || typeof payload?.method === "string") return true;
      request.done = true;
      clearTimeout(request.timer);
      relay.calendarRequests.delete(rpcIdKey(request.id));
      rememberClosed(relay, request.id);
      if (relay.upstreamOpen && relay.upstreamWs?.readyState === WebSocket.OPEN) {
        relay.upstreamWs.send(rawData, { binary: isBinary });
      }
      return true;
    }
    return !payload?.method && relay.calendarClosedRpcIds?.has?.(rpcIdKey(payload?.id));
  };
  const handleClientTurnLifecycle = (relay, meta, client) => {
    if (meta?.method === "turn/start") {
      relay.turnStarted = true;
      relay.turnCompleted = false;
      setTurnOwner(relay, client?.ws ? {
        ws: client.ws,
        operationId: client.operationId,
        sessionId: client.sessionId,
        threadId: meta.threadId || client.threadId || relay.threadId || "",
        turnId: "",
      } : null);
    }
    if (meta?.method === "turn/interrupt") {
      for (const request of Array.from(relay.calendarRequests?.values?.() || [])) {
        terminate(relay, request, "interrupt");
      }
    }
  };
  return {
    rpcIdKey,
    dynamicItem,
    runnerInitiatedResponse,
    terminate,
    terminateOwnerRequests,
    cleanupRelayState,
    handleUpstreamToolCall,
    handleClientResponse,
    handleClientTurnLifecycle,
  };
}
