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
  broadcast,
  log = console,
  now = Date.now,
}) {
  const broadcastedAtByTurn = new Map();
  const pushedAtByTurn = new Map();

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

  async function sendPush({ sessionId, threadId, turnId, previewText, directory, origin }) {
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
    const payload = {
      aps: {
        alert: { title: derivePushDirectoryTitle(directory) || "タスク完了", body: summary },
        sound: "default",
        category: "TURN_COMPLETED",
        "thread-id": id,
      },
      sessionId: id,
      turnId: String(turnId || ""),
    };
    await Promise.all(devices.map(async (device) => {
      try {
        const result = await apnsClient.sendToDevice(device.apnsToken, payload, { env: device.env });
        if (result?.status === 410) {
          await pushDeviceStore.removeDevice(device.deviceId);
        } else if (!result?.ok) {
          log.warn(
            `[push] apns send failed status=${result?.status || 0} reason=${result?.reason || ""} device=${maskApnsToken(device.apnsToken)}`
          );
        }
      } catch (error) {
        log.warn(`[push] apns send error device=${maskApnsToken(device.apnsToken)}: ${errorMessage(error)}`);
      }
    }));
  }

  async function notifyTurnCompleted({
    threadId: threadIdRaw,
    turnId: turnIdRaw,
    sessionId,
    agentMessageText,
    directory,
    origin,
  }) {
    const threadId = String(threadIdRaw || "").trim();
    const turnId = String(turnIdRaw || "").trim();
    const previewText = compactLlmCompletionPreview(agentMessageText);
    if (!threadId) return;
    const turnKey = `${threadId}|${turnId || "-"}`;
    const nowMs = Number(now());

    if (rememberTurn(broadcastedAtByTurn, turnKey, nowMs)) {
      try {
        broadcast({
          sessionId: String(sessionId || threadId),
          threadId,
          previewText,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        log.warn(`[push] turn completion broadcast failed origin=${origin || "unknown"}: ${errorMessage(error)}`);
      }
    }
    if (!previewText) return;
    if (!rememberTurn(pushedAtByTurn, turnKey, nowMs)) return;
    await sendPush({ sessionId, threadId, turnId, previewText, directory, origin });
  }

  return { notifyTurnCompleted };
}
