import { randomUUID } from "node:crypto";

import { AGENT_TERMINAL_EVENT_TYPES } from "./agent/agent-protocol.mjs";
import { maskApnsToken } from "./apns-client.mjs";
import {
  compactLlmCompletionPreview,
  derivePushDirectoryTitle,
} from "./turn-completion-notification.mjs";

const AGENT_APPROVAL_ID_PATTERN = /^agent-approval:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function rawApprovalBody(method, paramsRaw) {
  const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw : {};
  const command = [params.command, params.item?.command, params.request?.command]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  const args = Array.isArray(params.args)
    ? params.args
    : (Array.isArray(params.item?.args) ? params.item.args : []);
  const argsText = args.length > 0 ? ` ${args.map((item) => String(item ?? "")).join(" ")}` : "";
  const fallback = String(method || "").startsWith("item/fileChange") ? "ファイル変更" : "コマンド実行";
  return compactLlmCompletionPreview(command ? `${command}${argsText}` : fallback, 120) || fallback;
}

export function createApprovalPushService({
  enabled,
  runnerToken,
  apnsClient,
  deviceStore,
  getAgentSessionBinding,
  respondToAgentAction,
  getRawRelay,
  forwardRawData,
  parseAuthToken,
  readJsonBody,
  json,
  writeJsonRequestError,
}) {
  const pendingAgentApprovals = new Map();

  function isNeutralApprovalEvent(event) {
    const decisions = event?.payload?.decisions;
    return Boolean(event?.type === "action.requested"
      && String(event?.runId || "").trim()
      && event?.sessionRef?.backendId
      && event?.sessionRef?.nativeSessionId
      && String(event?.payload?.requestId || "").trim()
      && event?.payload?.kind !== "dynamic_tool"
      && Array.isArray(decisions)
      && decisions.includes("allow")
      && decisions.includes("deny"));
  }

  async function send({ approvalId, backendId, sessionId, directory, title, body, isPending }) {
    if (!enabled || !apnsClient) return;
    let devices;
    try {
      devices = await deviceStore.listDevices();
    } catch (error) {
      console.warn(`[push] failed to list devices: ${errorMessage(error)}`);
      return;
    }
    if (devices.length === 0 || !isPending()) return;
    const payload = {
      aps: {
        alert: { title, body },
        sound: "default",
        category: "APPROVAL_REQUEST",
        "interruption-level": "time-sensitive",
      },
      approvalId,
      ...(backendId ? { backendId } : {}),
      sessionId,
      directory,
    };
    let sentCount = 0;
    await Promise.all(devices.map(async (device) => {
      if (!isPending()) return;
      try {
        const result = await apnsClient.sendToDevice(device.apnsToken, payload, { env: device.env });
        if (result?.status === 410) {
          await deviceStore.removeDevice(device.deviceId);
        } else if (!result?.ok) {
          console.warn(
            `[push] apns send failed status=${result?.status || 0} reason=${result?.reason || ""} device=${maskApnsToken(device.apnsToken)}`
          );
        } else {
          sentCount += 1;
        }
      } catch (error) {
        console.warn(`[push] apns send error device=${maskApnsToken(device.apnsToken)}: ${errorMessage(error)}`);
      }
    }));
    if (sentCount > 0) {
      console.log(`[push] approval push sent devices=${sentCount}/${devices.length} approvalId=${approvalId}`);
    }
  }

  async function sendAgentApproval(approvalId, entry) {
    let binding = null;
    try {
      binding = await getAgentSessionBinding(entry.sessionRef);
    } catch {}
    const directory = String(binding?.canonicalCwd || "");
    await send({
      approvalId,
      backendId: String(entry.sessionRef.backendId),
      sessionId: String(entry.sessionRef.nativeSessionId),
      directory,
      title: derivePushDirectoryTitle(directory) || "承認リクエスト",
      body: compactLlmCompletionPreview(entry.title, 120) || "承認リクエスト",
      isPending: () => pendingAgentApprovals.get(approvalId) === entry && entry.responding === false,
    });
  }

  function onRunEvent(event) {
    const runId = String(event?.runId || "").trim();
    const requestId = String(event?.payload?.requestId || "").trim();
    if (event?.type === "action.resolved") {
      for (const [approvalId, entry] of pendingAgentApprovals) {
        if (entry.runId === runId && entry.requestId === requestId) pendingAgentApprovals.delete(approvalId);
      }
      return;
    }
    if (AGENT_TERMINAL_EVENT_TYPES.has(event?.type)) {
      for (const [approvalId, entry] of pendingAgentApprovals) {
        if (entry.runId === runId) pendingAgentApprovals.delete(approvalId);
      }
      return;
    }
    if (!isNeutralApprovalEvent(event)) return;
    const approvalId = `agent-approval:${randomUUID()}`;
    const entry = {
      runId,
      requestId,
      sessionRef: event.sessionRef,
      title: String(event.payload.title || ""),
      responding: false,
    };
    pendingAgentApprovals.set(approvalId, entry);
    void sendAgentApproval(approvalId, entry).catch((error) => {
      console.warn(`[push] agent approval send failed: ${errorMessage(error)}`);
    });
  }

  async function sendRawApprovalRequest(relay, rpcId, method, params) {
    await send({
      approvalId: `${relay.relayId}:${rpcId}`,
      sessionId: String(relay.threadId || relay.runnerWsLlmSessionId || ""),
      directory: String(relay.threadCwd || ""),
      title: derivePushDirectoryTitle(relay?.threadCwd) || "承認リクエスト",
      body: rawApprovalBody(method, params),
      isPending: () => relay?.pendingApprovalRequestIds?.has?.(rpcId) === true,
    });
  }

  function notPending(res) {
    return json(res, 409, { error: "approval_not_pending", message: "approval already responded or expired" });
  }

  async function respondToNeutralApproval(res, approvalId, approved) {
    if (!AGENT_APPROVAL_ID_PATTERN.test(approvalId)) {
      return json(res, 400, { error: "invalid_approval_id", message: "approval id is malformed" });
    }
    const entry = pendingAgentApprovals.get(approvalId);
    if (!entry || entry.responding) return notPending(res);
    entry.responding = true;
    try {
      await respondToAgentAction({
        runId: entry.runId,
        requestId: entry.requestId,
        decision: approved ? "allow" : "deny",
      });
      return json(res, 200, { ok: true, enabled: true, approved });
    } catch (error) {
      if (pendingAgentApprovals.get(approvalId) === entry) entry.responding = false;
      if (error?.code === "action_expired") {
        pendingAgentApprovals.delete(approvalId);
        return notPending(res);
      }
      return json(res, 500, { error: "push_approval_respond_failed", message: errorMessage(error) });
    }
  }

  function respondToRawApproval(res, approvalId, approved) {
    const separatorIndex = approvalId.lastIndexOf(":");
    const relayId = separatorIndex > 0 ? approvalId.slice(0, separatorIndex) : "";
    const rpcId = separatorIndex > 0 ? Number(approvalId.slice(separatorIndex + 1)) : NaN;
    if (!relayId || !Number.isInteger(rpcId)) {
      return json(res, 400, { error: "invalid_approval_id", message: "approval id is malformed" });
    }
    const relay = getRawRelay(relayId);
    if (!relay || relay.closed || !relay.pendingApprovalRequestIds?.has?.(rpcId)) return notPending(res);
    try {
      forwardRawData(relay, JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        result: { decision: approved ? "accept" : "decline" },
      }));
      return json(res, 200, { ok: true, enabled: true, approved });
    } catch (error) {
      return json(res, 500, { error: "push_approval_respond_failed", message: errorMessage(error) });
    }
  }

  async function handleHttpRequest(req, res, pathname) {
    if (req.method !== "POST" || !pathname.startsWith("/push/approvals/") || !pathname.endsWith("/respond")) {
      return false;
    }
    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return true;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!enabled) {
      json(res, 200, { ok: true, enabled: false });
      return true;
    }
    let approvalId = "";
    try {
      approvalId = decodeURIComponent(
        pathname.slice("/push/approvals/".length, pathname.length - "/respond".length)
      ).trim();
    } catch {}
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      writeJsonRequestError(res, error, "push_approval_respond_failed");
      return true;
    }
    if (typeof body?.approved !== "boolean") {
      json(res, 400, { error: "invalid_request", message: "approved (boolean) is required" });
      return true;
    }
    if (approvalId.startsWith("agent-approval:")) {
      await respondToNeutralApproval(res, approvalId, body.approved);
    } else {
      respondToRawApproval(res, approvalId, body.approved);
    }
    return true;
  }

  return { handleHttpRequest, onRunEvent, sendRawApprovalRequest };
}
