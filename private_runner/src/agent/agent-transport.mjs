import {
  AGENT_EVENT_TYPES,
  AGENT_PROTOCOL_VERSION,
  AGENT_TERMINAL_EVENT_TYPES,
  serializeAgentError,
} from "./agent-protocol.mjs";

export function createAgentHttpHandler({
  service,
  runnerToken,
  parseAuthToken,
  json,
  normalizeSessionListLimit,
  normalizeSessionMessagesLimit,
  readJsonBody,
  workspaceAdmission,
  subjectId = "runner-token",
}) {
  function authenticate(req, res) {
    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return false;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  return async function handleAgentHttp(req, res, reqUrl, pathname) {
    if (req.method === "GET" && pathname === "/agent/backends/status") {
      if (!authenticate(req, res)) return true;
      try {
        json(res, 200, {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          backends: await service.getStatuses(),
        });
      } catch (error) {
        json(res, 503, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/agent/sessions") {
      if (!authenticate(req, res)) return true;
      try {
        json(res, 200, await service.listSessions({
          backendId: String(reqUrl.searchParams.get("backendId") || "").trim(),
          cwd: String(reqUrl.searchParams.get("cwd") || "").trim(),
          cursor: String(reqUrl.searchParams.get("cursor") || "").trim(),
          limit: normalizeSessionListLimit(reqUrl.searchParams.get("limit")),
          ...(reqUrl.searchParams.get("includeSubagents") === "false" ? { includeSubagents: false } : {}),
        }));
      } catch (error) {
        json(res, error?.code === "backend_unavailable" ? 404 : 400, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/agent/session-history") {
      if (!authenticate(req, res)) return true;
      const backendId = String(reqUrl.searchParams.get("backendId") || "").trim();
      try {
        json(res, 200, await service.readHistory({
          sessionRef: {
            backendId,
            nativeSessionId: String(reqUrl.searchParams.get("sessionId") || "").trim(),
          },
          cursor: String(reqUrl.searchParams.get("cursor") || "").trim(),
          sinceCursor: String(reqUrl.searchParams.get("sinceCursor") || "").trim(),
          limit: normalizeSessionMessagesLimit(reqUrl.searchParams.get("limit")),
        }));
      } catch (error) {
        json(res, error?.code === "session_not_found" ? 404 : 400, {
          error: serializeAgentError(error, backendId),
        });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/agent/workspaces") {
      if (!authenticate(req, res)) return true;
      try {
        json(res, 200, { workspaces: await workspaceAdmission.list(subjectId) });
      } catch (error) {
        json(res, 400, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/agent/workspaces/prepare") {
      if (!authenticate(req, res)) return true;
      try {
        const body = await readJsonBody(req, 16 * 1024);
        json(res, 200, await workspaceAdmission.prepare(subjectId, body?.path));
      } catch (error) {
        json(res, 400, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/agent/workspaces/confirm") {
      if (!authenticate(req, res)) return true;
      try {
        const body = await readJsonBody(req, 8 * 1024);
        json(res, 200, { workspace: await workspaceAdmission.confirm(subjectId, body?.requestId) });
      } catch (error) {
        json(res, 400, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/agent/workspaces/revoke") {
      if (!authenticate(req, res)) return true;
      try {
        const body = await readJsonBody(req, 16 * 1024);
        const workspace = await workspaceAdmission.revoke(subjectId, body?.canonicalRoot);
        json(res, workspace ? 200 : 404, workspace ? { workspace } : { error: "workspace_not_found" });
      } catch (error) {
        json(res, 400, { error: serializeAgentError(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/agent/session-mode") {
      if (!authenticate(req, res)) return true;
      try {
        const body = await readJsonBody(req, 16 * 1024);
        json(res, 200, await service.handoffSession(body));
      } catch (error) {
        json(res, 409, { error: serializeAgentError(error) });
      }
      return true;
    }
    return false;
  };
}

export function createAgentWsConnection({ service, ws, sendEnvelope, subjectId, workspaceAdmission }) {
  const subscriptions = new Map();

  function sendError(message, error) {
    sendEnvelope(ws, {
      channel: "agent",
      op: "error",
      requestId: message.requestId || "",
      operationId: message.operationId || "",
      streamId: message.streamId || "",
      payload: serializeAgentError(error),
    });
  }

  function sendEvent(event) {
    sendEnvelope(ws, {
      channel: "agent",
      op: "event",
      operationId: event.runId,
      streamId: event.runId,
      sessionId: event.sessionRef?.nativeSessionId || "",
      seq: event.sequence,
      payload: event,
    });
    if (AGENT_TERMINAL_EVENT_TYPES.has(event.type)) {
      queueMicrotask(() => {
        subscriptions.get(event.runId)?.unsubscribe();
        subscriptions.delete(event.runId);
      });
    }
  }

  function attach(runId, afterSequence = 0) {
    subscriptions.get(runId)?.unsubscribe();
    const subscription = service.subscribe(runId, { afterSequence, onEvent: sendEvent });
    subscriptions.set(runId, subscription);
    return subscription;
  }

  function payloadObject(message) {
    return message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? message.payload
      : {};
  }

  function runIdFrom(message, payload) {
    return String(message.streamId || message.operationId || payload.runId || "").trim();
  }

  function handleMessage(message) {
    if (message.channel !== "agent") return false;
    if (message.op === "agent.hello") {
      void service.getStatuses().then((backends) => sendEnvelope(ws, {
        channel: "agent",
        op: "agent.ready",
        requestId: message.requestId || "",
        payload: {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          supportedProtocolVersions: [AGENT_PROTOCOL_VERSION],
          operations: [
            "turn.start", "turn.interrupt", "action.respond", "events.resume", "session.handoff",
            "session.compact", "sessions.list", "history.read", "workspaces.list", "workspace.prepare", "workspace.confirm", "workspace.revoke",
          ],
          events: Array.from(AGENT_EVENT_TYPES),
          backends,
        },
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "turn.start") {
      const payload = payloadObject(message);
      void service.startTurn({
        ...payload,
        clientOperationId: payload.clientOperationId || message.operationId,
      }, { subjectId }).then((run) => {
        if (run.result) {
          sendEnvelope(ws, {
            channel: "agent",
            op: "turn.result",
            requestId: message.requestId || "",
            operationId: message.operationId || "",
            streamId: run.runId,
            payload: run.result,
          });
        } else {
          sendEnvelope(ws, {
            channel: "agent",
            op: "turn.accepted",
            requestId: message.requestId || "",
            operationId: message.operationId || "",
            streamId: run.runId,
            payload: { runId: run.runId, queued: run.queued === true },
          });
          attach(run.runId, 0);
        }
      }).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "events.resume") {
      const payload = payloadObject(message);
      const runId = runIdFrom(message, payload);
      try {
        const subscription = attach(runId, Number(message.seq || payload.afterSequence || 0));
        sendEnvelope(ws, {
          channel: "agent",
          op: "events.resumed",
          requestId: message.requestId || "",
          operationId: message.operationId || "",
          streamId: runId,
          payload: {
            resumeMiss: subscription.resumeMiss,
            activeActions: subscription.activeActions,
          },
        });
      } catch (error) {
        sendError(message, error);
      }
      return true;
    }
    if (message.op === "turn.interrupt") {
      const payload = payloadObject(message);
      const runId = runIdFrom(message, payload);
      void service.interrupt(runId).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "turn.interrupt.accepted",
        requestId: message.requestId || "",
        streamId: runId,
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "action.respond") {
      const payload = payloadObject(message);
      const runId = runIdFrom(message, payload);
      void service.respondToAction({
        runId,
        requestId: payload.requestId,
        decision: payload.decision,
        result: payload.result,
      }).then(() => sendEnvelope(ws, {
        channel: "agent",
        op: "action.response.accepted",
        requestId: message.requestId || "",
        streamId: runId,
        payload: { requestId: String(payload.requestId || "") },
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "session.handoff") {
      const payload = payloadObject(message);
      void service.handoffSession(payload).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "session.handoff.completed",
        requestId: message.requestId || "",
        sessionId: result.sessionRef.nativeSessionId,
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "session.compact") {
      const payload = payloadObject(message);
      void service.compactSession(payload).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "session.compact.completed",
        requestId: message.requestId || "",
        sessionId: result.sessionRef.nativeSessionId,
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "sessions.list") {
      const payload = payloadObject(message);
      void service.listSessions(payload).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "sessions.list.result",
        requestId: message.requestId || "",
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "history.read") {
      const payload = payloadObject(message);
      void service.readHistory(payload).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "history.read.result",
        requestId: message.requestId || "",
        sessionId: String(payload?.sessionRef?.nativeSessionId || ""),
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "workspaces.list") {
      void workspaceAdmission.list(subjectId).then((workspaces) => sendEnvelope(ws, {
        channel: "agent",
        op: "workspaces.list.result",
        requestId: message.requestId || "",
        payload: { workspaces },
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "workspace.prepare") {
      const payload = payloadObject(message);
      void workspaceAdmission.prepare(subjectId, payload.path).then((result) => sendEnvelope(ws, {
        channel: "agent",
        op: "workspace.prepare.result",
        requestId: message.requestId || "",
        payload: result,
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "workspace.confirm") {
      const payload = payloadObject(message);
      void workspaceAdmission.confirm(subjectId, payload.requestId).then((workspace) => sendEnvelope(ws, {
        channel: "agent",
        op: "workspace.confirm.result",
        requestId: message.requestId || "",
        payload: { workspace },
      })).catch((error) => sendError(message, error));
      return true;
    }
    if (message.op === "workspace.revoke") {
      const payload = payloadObject(message);
      void workspaceAdmission.revoke(subjectId, payload.canonicalRoot).then((workspace) => sendEnvelope(ws, {
        channel: "agent",
        op: "workspace.revoke.result",
        requestId: message.requestId || "",
        payload: { workspace },
      })).catch((error) => sendError(message, error));
      return true;
    }
    return false;
  }

  return {
    handleMessage,
    detach() {
      for (const subscription of subscriptions.values()) subscription.unsubscribe();
      subscriptions.clear();
    },
  };
}
