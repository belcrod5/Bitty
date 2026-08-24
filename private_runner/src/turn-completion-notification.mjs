import { maskApnsToken } from "./apns-client.mjs";

const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

export function compactLlmCompletionPreview(textRaw, maxChars = 180) {
  const text = String(textRaw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function derivePushDirectoryTitle(pathRaw) {
  const dirPath = String(pathRaw || "").trim();
  const segments = dirPath.split("/").filter(Boolean);
  const title = String(segments[segments.length - 1] || dirPath).trim();
  return compactLlmCompletionPreview(title, 60);
}

export function createTurnCompletionNotifier({
  pushEnabled,
  apnsClient,
  pushSummarizer,
  pushDeviceStore,
  getPushUnreadSnapshot,
  getAgentSessionBinding,
  broadcast,
  log = console,
  now = Date.now,
}) {
  const broadcastedAtByTurn = new Map();
  const pushedAtByTurn = new Map();
  const agentRuns = new Map();

  function rememberTurn(map, key, nowMs) {
    for (const [existingKey, notifiedAt] of map) {
      if (nowMs - notifiedAt >= DEDUP_TTL_MS) map.delete(existingKey);
    }
    if (map.has(key)) return false;
    map.set(key, nowMs);
    if (map.size > DEDUP_MAX_ENTRIES) {
      const oldest = [...map.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(0, map.size - DEDUP_MAX_ENTRIES);
      for (const [oldestKey] of oldest) map.delete(oldestKey);
    }
    return true;
  }

  async function sendPush({ backendId, sessionId, threadId, turnId, previewText, directory, origin }) {
    if (!pushEnabled || !apnsClient || !pushSummarizer) return;
    let devices;
    try {
      devices = await pushDeviceStore.listDevices();
    } catch (error) {
      log.warn(`[push] failed to list devices origin=${origin || "unknown"}: ${errorMessage(error)}`);
      return;
    }
    if (devices.length === 0) return;

    let summary;
    try {
      summary = await pushSummarizer.summarize(previewText);
    } catch (error) {
      log.warn(`[push] turn completion summary failed origin=${origin || "unknown"}: ${errorMessage(error)}`);
      return;
    }
    if (!summary) return;

    const id = String(sessionId || threadId || "");
    const directorySets = [];
    const directorySetIndexByKey = new Map();
    for (const device of devices) {
      if (!Array.isArray(device.directories) || device.directories.length <= 0) continue;
      const key = [...device.directories].sort().join("\u0000");
      if (directorySetIndexByKey.has(key)) continue;
      directorySetIndexByKey.set(key, directorySets.length);
      directorySets.push(device.directories);
    }
    let unreadSnapshot;
    try {
      unreadSnapshot = await getPushUnreadSnapshot({
        directorySets,
        targetBackendId: backendId,
        targetSessionId: id,
        targetDirectory: directory,
      });
    } catch (error) {
      log.warn(`[push] unread snapshot failed session=${id}: ${errorMessage(error)}`);
      return;
    }
    if (!unreadSnapshot?.targetUnread) return;
    const payloadDirectory = String(unreadSnapshot.directory || directory || "").trim();
    const basePayload = {
      aps: {
        alert: { title: derivePushDirectoryTitle(payloadDirectory) || "タスク完了", body: summary },
        sound: "default",
        category: "TURN_COMPLETED",
        "thread-id": id,
      },
      sessionId: id,
      backendId: String(backendId || "codex").trim() || "codex",
      directory: payloadDirectory,
      turnId: String(turnId || ""),
    };
    const sentResults = await Promise.all(devices.map(async (device) => {
      try {
        const directoryKey = Array.isArray(device.directories) && device.directories.length > 0
          ? [...device.directories].sort().join("\u0000")
          : "";
        const directorySetIndex = directorySetIndexByKey.get(directoryKey);
        const badge = directorySetIndex === undefined
          ? undefined
          : unreadSnapshot.unreadCounts?.[directorySetIndex];
        const payload = Number.isFinite(Number(badge))
          ? { ...basePayload, aps: { ...basePayload.aps, badge: Math.max(0, Math.floor(Number(badge))) } }
          : basePayload;
        const result = await apnsClient.sendToDevice(device.apnsToken, payload, { env: device.env });
        if (result?.status === 410) {
          await pushDeviceStore.removeDevice(device.deviceId);
        } else if (!result?.ok) {
          log.warn(
            `[push] apns send failed status=${result?.status || 0} reason=${result?.reason || ""} device=${maskApnsToken(device.apnsToken)}`
          );
        }
        return Boolean(result?.ok);
      } catch (error) {
        log.warn(`[push] apns send error device=${maskApnsToken(device.apnsToken)}: ${errorMessage(error)}`);
        return false;
      }
    }));
    const sentCount = sentResults.filter(Boolean).length;
    if (sentCount > 0) {
      log.log?.(`[push] turn completion push sent devices=${sentCount}/${devices.length} session=${id}`);
    }
  }

  async function notifyTurnCompleted({
    backendId = "codex",
    threadId: threadIdRaw,
    turnId: turnIdRaw,
    sessionId,
    agentMessageText,
    directory,
    origin,
  }) {
    const normalizedBackendId = String(backendId || "codex").trim() || "codex";
    const threadId = String(threadIdRaw || "").trim();
    const turnId = String(turnIdRaw || "").trim();
    const previewText = compactLlmCompletionPreview(agentMessageText);
    if (!threadId) return;
    const turnKey = JSON.stringify([normalizedBackendId, threadId, turnId]);
    const nowMs = Number(now());

    if (rememberTurn(broadcastedAtByTurn, turnKey, nowMs)) {
      try {
        broadcast({
          backendId: normalizedBackendId,
          sessionId: String(sessionId || threadId),
          threadId,
          directory: String(directory || "").trim(),
          previewText,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        log.warn(`[push] turn completion broadcast failed origin=${origin || "unknown"}: ${errorMessage(error)}`);
      }
    }
    if (!previewText) return;
    if (!rememberTurn(pushedAtByTurn, turnKey, nowMs)) return;
    await sendPush({
      backendId: normalizedBackendId,
      sessionId,
      threadId,
      turnId,
      previewText,
      directory,
      origin,
    });
  }

  async function onAgentRunEvent(event) {
    const runId = String(event?.runId || "").trim();
    if (!runId) return;

    if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.failed") {
      const run = agentRuns.get(runId);
      agentRuns.delete(runId);
      if (event.type !== "turn.completed" || !run) return;
      const sessionRef = event.sessionRef || run.sessionRef;
      const backendId = String(sessionRef?.backendId || "").trim();
      const sessionId = String(sessionRef?.nativeSessionId || "").trim();
      if (!backendId || !sessionId) return;
      let binding = null;
      try {
        binding = typeof getAgentSessionBinding === "function"
          ? await getAgentSessionBinding(sessionRef)
          : null;
      } catch (error) {
        log.warn(`[push] agent session binding failed run=${runId}: ${errorMessage(error)}`);
      }
      return await notifyTurnCompleted({
        backendId,
        sessionId,
        threadId: sessionId,
        turnId: run.nativeTurnId || runId,
        agentMessageText: run.lastAssistantText,
        directory: String(binding?.canonicalCwd || ""),
        origin: "agent",
      });
    }

    if (event.type === "turn.started") {
      agentRuns.set(runId, {
        sessionRef: event.sessionRef,
        nativeTurnId: String(event.payload?.nativeTurnId || "").trim(),
        lastAssistantItemId: "",
        lastAssistantText: "",
      });
      return;
    }

    const run = agentRuns.get(runId);
    if (!run) return;
    const itemId = String(event.payload?.itemId || "").trim();
    if (!itemId) return;
    if (event.type === "item.started" && event.payload?.itemType === "assistant") {
      run.lastAssistantItemId = itemId;
      run.lastAssistantText = "";
      return;
    }
    if (itemId !== run.lastAssistantItemId) return;
    if (event.type === "content.delta") {
      run.lastAssistantText += String(event.payload?.delta || "");
      return;
    }
    if (event.type === "item.completed") {
      const snapshotText = Array.isArray(event.payload?.content)
        ? event.payload.content
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text || ""))
          .join("")
        : "";
      if (snapshotText) run.lastAssistantText = snapshotText;
    }
  }

  return { notifyTurnCompleted, onAgentRunEvent };
}
