const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

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
  return { threadId: activeThreadId, turnId };
}
