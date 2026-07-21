const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const SUCCESSFUL_TURN_STATUSES = new Set(["", "completed", "complete", "succeeded", "success"]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return "";
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

export async function executeCodexTurn({
  client,
  clientName,
  threadId = "",
  inputText,
  cwd,
  model = "",
  effort = "",
  approvalPolicy = "on-request",
  onTurnStarted,
}) {
  const text = String(inputText || "").trim();
  const directory = String(cwd || "").trim();
  let activeThreadId = String(threadId || "").trim();
  if (!text) throw new Error("inputText is required");
  if (typeof client?.addNotificationListener !== "function") {
    throw new Error("client.addNotificationListener is required");
  }

  await client.openPromise;
  await client.request("initialize", {
    clientInfo: {
      name: clientName,
      title: clientName,
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: false,
      optOutNotificationMethods: [],
    },
  }, 30000);
  client.notify("initialized", {});

  if (activeThreadId) {
    const resumed = await client.request("thread/resume", {
      threadId: activeThreadId,
      cwd: directory || undefined,
      persistExtendedHistory: false,
    }, 30000).catch(() => null);
    activeThreadId = String(resumed?.thread?.id || activeThreadId).trim();
  } else {
    const started = await client.request("thread/start", {
      cwd: directory || undefined,
      serviceName: clientName,
      approvalPolicy,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }, 30000);
    activeThreadId = String(started?.thread?.id || "").trim();
  }
  if (!activeThreadId) throw new Error("thread id was not returned from app-server");

  let lastAgentMessageText = "";
  let turnCompleted = false;
  const removeNotificationListener = client.addNotificationListener((method, params) => {
    if (method === "turn/completed") {
      const status = String(params?.turn?.status || params?.status || "").trim().toLowerCase();
      turnCompleted = SUCCESSFUL_TURN_STATUSES.has(status);
      return;
    }
    if (method === "item/agentMessage/delta") {
      lastAgentMessageText += String(params?.delta || "");
      return;
    }
    if (method !== "item/completed" || String(params?.item?.type || "").trim() !== "agentMessage") return;
    const completedText = extractCodexAgentMessageText(params.item);
    if (completedText) lastAgentMessageText = completedText;
  });
  try {
    const completion = client.waitForTurnCompletion();
    const params = {
      threadId: activeThreadId,
      input: [{ type: "text", text }],
      cwd: directory || undefined,
      approvalPolicy,
    };
    const normalizedModel = String(model || "").trim();
    if (normalizedModel) params.model = normalizedModel;
    const normalizedEffort = String(effort || "").trim().toLowerCase();
    if (VALID_EFFORTS.has(normalizedEffort)) params.effort = normalizedEffort;
    const started = await client.request("turn/start", params, 30000);
    const turnId = String(started?.turn?.id || "").trim();
    onTurnStarted?.({ threadId: activeThreadId, turnId });
    await completion;
    if (!turnCompleted) throw new Error("Codex turn ended without completing");
    return { threadId: activeThreadId, turnId, lastAgentMessageText };
  } finally {
    removeNotificationListener();
  }
}
