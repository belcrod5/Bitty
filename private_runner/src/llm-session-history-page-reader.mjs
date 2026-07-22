import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

const CURSOR_VERSION = 1;
const CHUNK_BYTES = 64 * 1024;
const MAX_JSON_LINE_BYTES = 256 * 1024;
const CURSOR_HASH_BYTES = 128;

export function createLlmSessionHistoryPageReader(deps) {
  const {
    makeApiError,
    normalizeSessionMessagesLimit,
    normalizeSessionUpdatedAt,
    parseSessionMessageFromEventItem,
    parseSessionMessageFromResponseItem,
    readSessionHeaderContext,
  } = deps;

  function fingerprint(parts) {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
  }

  function rowId(row, kind) {
    const persistentId = String(row?.itemId || "").trim();
    if (persistentId) return persistentId;
    return `history-${fingerprint([
      kind,
      String(row?.role || ""),
      String(row?.at || ""),
      String(row?.content || ""),
      String(row?.commandExecution?.command || ""),
    ])}`;
  }

  function commandText(raw, direct = false) {
    if (Array.isArray(raw)) return raw.map((item) => String(item || "")).filter(Boolean).join(" ").trim();
    if (raw && typeof raw === "object") {
      return commandText(raw.command ?? raw.cmd ?? raw.argv ?? raw.script, true);
    }
    const text = String(raw || "").trim();
    if (!text) return "";
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return commandText(JSON.parse(text));
      } catch {}
    }
    const match = text.match(/(?:^|[,{]\s*)["']?(?:cmd|command)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/s);
    if (match) {
      try {
        if (match[1].startsWith('"')) return String(JSON.parse(match[1]) || "").trim();
        return match[1].slice(1, -1).replace(/\\(['\\])/g, "$1").trim();
      } catch {}
    }
    return direct ? text : "";
  }

  function parseCommandCall(parsed, outcomesByCallId) {
    if (String(parsed?.type || "") !== "response_item") return null;
    const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
    const payloadType = String(payload?.type || "").trim().toLowerCase();
    if (!payload || (payloadType !== "function_call" && payloadType !== "custom_tool_call")) return null;
    const command = payload?.command !== undefined
      ? commandText(payload.command, true)
      : commandText(payload?.arguments ?? payload?.input);
    if (!command) return null;
    const callId = String(payload?.call_id || payload?.callId || payload?.id || "").trim();
    const outcome = outcomesByCallId.get(callId) || {};
    const exitCode = outcome.exitCode === null || outcome.exitCode === undefined
      ? Number.NaN
      : Number(outcome.exitCode);
    const status = outcome.status === "failed" || (Number.isFinite(exitCode) && exitCode !== 0)
      ? "failed"
      : outcome.status === "completed"
        ? "completed"
        : "running";
    const row = {
      role: "assistant",
      content: "",
      at: normalizeSessionUpdatedAt(parsed?.timestamp || payload?.timestamp) || "",
      itemId: callId || undefined,
      commandExecution: {
        command,
        status,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
      },
    };
    row.itemId = rowId(row, "command");
    return row;
  }

  function recordCommandOutcome(parsed, outcomesByCallId) {
    if (String(parsed?.type || "") !== "response_item") return;
    const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
    const payloadType = String(payload?.type || "").trim().toLowerCase();
    if (!payload || (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output")) return;
    const callId = String(payload?.call_id || payload?.callId || payload?.id || "").trim();
    if (!callId) return;
    const output = payload?.output;
    const outputObject = output && typeof output === "object" ? output : {};
    const exitCodeRaw = payload?.exit_code ?? payload?.exitCode ?? outputObject?.exit_code ?? outputObject?.exitCode;
    let exitCode = Number(exitCodeRaw);
    if (!Number.isFinite(exitCode) && typeof output === "string") {
      const match = output.match(/(?:exit_code|exitCode)[\\"']*\s*[:=]\s*(-?\d+)/);
      exitCode = Number(match?.[1]);
    }
    const rawStatus = String(payload?.status || outputObject?.status || "").trim().toLowerCase();
    outcomesByCallId.set(callId, {
      status: rawStatus.includes("fail") || rawStatus.includes("error") || (Number.isFinite(exitCode) && exitCode !== 0)
        ? "failed"
        : "completed",
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
    });
  }

  function recordOversizedCommandOutcome(line, outcomesByCallId) {
    const prefix = String(line?.prefix || "");
    if (!/"type"\s*:\s*"(?:function_call_output|custom_tool_call_output)"/.test(prefix)) return;
    const callId = prefix.match(/"(?:call_id|callId)"\s*:\s*"([^"\\]+)"/)?.[1] || "";
    if (!callId) return;
    const suffix = String(line?.suffix || "");
    const exitCodeText = suffix.match(/(?:exit_code|exitCode)[\\"']*\s*[:=]\s*(-?\d+)/)?.[1];
    const exitCode = Number(exitCodeText);
    outcomesByCallId.set(callId, {
      status: Number.isFinite(exitCode) && exitCode !== 0 ? "failed" : "completed",
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
    });
  }

  function decodeCursor(rawCursor, sessionId) {
    try {
      const parsed = JSON.parse(Buffer.from(String(rawCursor || ""), "base64url").toString("utf8"));
      if (
        parsed?.v !== CURSOR_VERSION
        || String(parsed?.sessionId || "") !== sessionId
        || !Number.isSafeInteger(parsed?.end)
        || parsed.end < 0
        || !String(parsed?.boundaryHash || "")
      ) {
        throw new Error("invalid cursor");
      }
      return parsed;
    } catch {
      throw makeApiError(400, "invalid_history_cursor", "履歴カーソルが無効です");
    }
  }

  async function hashBoundary(handle, endOffset, fileSize) {
    const start = Math.max(0, endOffset - CURSOR_HASH_BYTES);
    const end = Math.min(fileSize, endOffset + CURSOR_HASH_BYTES);
    const buffer = Buffer.alloc(Math.max(0, end - start));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    return fingerprint([String(endOffset), buffer.toString("base64")]);
  }

  function prependFragment(pending, fragment) {
    if (fragment.length <= 0) return pending;
    const nextSize = pending.size + fragment.length;
    if (pending.full && nextSize <= MAX_JSON_LINE_BYTES) {
      return { size: nextSize, full: Buffer.concat([fragment, pending.full]), prefix: null, suffix: null };
    }
    const oldPrefix = pending.full ? pending.full.subarray(0, CHUNK_BYTES) : pending.prefix || Buffer.alloc(0);
    const oldSuffix = pending.full
      ? pending.full.subarray(Math.max(0, pending.full.length - CHUNK_BYTES))
      : pending.suffix || Buffer.alloc(0);
    const prefix = Buffer.concat([fragment, oldPrefix]).subarray(0, CHUNK_BYTES);
    const suffix = pending.size >= CHUNK_BYTES
      ? oldSuffix
      : Buffer.concat([fragment, oldSuffix]).subarray(-CHUNK_BYTES);
    return { size: nextSize, full: null, prefix, suffix };
  }

  async function scanLinesBackward(handle, endOffset, onLine) {
    let position = endOffset;
    let pending = { size: 0, full: Buffer.alloc(0), prefix: null, suffix: null };
    let bytesReadTotal = 0;
    const emitPending = async (start) => {
      if (pending.size <= 0) return false;
      const line = pending.full
        ? { text: pending.full.toString("utf8").replace(/\r$/, ""), oversized: false }
        : {
          prefix: pending.prefix.toString("utf8"),
          suffix: pending.suffix.toString("utf8"),
          oversized: true,
          byteLength: pending.size,
        };
      pending = { size: 0, full: Buffer.alloc(0), prefix: null, suffix: null };
      return onLine(line, start) === true;
    };
    while (position > 0) {
      const start = Math.max(0, position - CHUNK_BYTES);
      const chunk = Buffer.alloc(position - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      bytesReadTotal += bytesRead;
      let segmentEnd = bytesRead;
      while (segmentEnd > 0) {
        const newline = chunk.lastIndexOf(0x0a, segmentEnd - 1);
        if (newline < 0) {
          pending = prependFragment(pending, chunk.subarray(0, segmentEnd));
          break;
        }
        pending = prependFragment(pending, chunk.subarray(newline + 1, segmentEnd));
        if (await emitPending(start + newline + 1)) {
          return { bytesRead: bytesReadTotal, reachedStart: false };
        }
        segmentEnd = newline;
      }
      position = start;
    }
    if (pending.size > 0) await emitPending(0);
    return { bytesRead: bytesReadTotal, reachedStart: true };
  }

  // Codex legacy thread paging still replays the full rollout (upstream #25215),
  // so saved history is read here from the end without transporting tool output.
  return async function readSessionHistoryPage(filePath, opts = {}) {
    const startedAt = Date.now();
    const limit = normalizeSessionMessagesLimit(opts?.limit);
    const sessionId = String(opts?.sessionId || "").trim();
    let handle;
    try {
      handle = await fs.open(filePath, "r");
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "ENOENT") throw error;
      return {
        messages: [],
        olderCursor: null,
        diagnostics: { totalMs: Math.max(0, Date.now() - startedAt), bytesRead: 0, parsedLineCount: 0 },
      };
    }
    try {
      const stat = await handle.stat();
      const fileSize = Number(stat.size || 0);
      let endOffset = fileSize;
      if (opts?.cursor) {
        const cursor = decodeCursor(opts.cursor, sessionId);
        if (
          String(cursor.dev) !== String(stat.dev)
          || String(cursor.ino) !== String(stat.ino)
          || cursor.end > fileSize
          || cursor.boundaryHash !== await hashBoundary(handle, cursor.end, fileSize)
        ) {
          throw makeApiError(409, "stale_history_cursor", "履歴が更新されたため、セッションを開き直してください");
        }
        endOffset = cursor.end;
      }
      const header = await readSessionHeaderContext(filePath, stat);
      const outcomesByCallId = new Map();
      const primaryRows = [];
      const fallbackRows = [];
      const primaryFingerprints = new Set();
      let parsedLineCount = 0;
      let oversizedLineCount = 0;
      let scannedLineCount = 0;
      const scan = await scanLinesBackward(handle, endOffset, (line, start) => {
        scannedLineCount += 1;
        if (line.oversized) {
          oversizedLineCount += 1;
          recordOversizedCommandOutcome(line, outcomesByCallId);
          return false;
        }
        if (!line.text.trim()) return false;
        let parsed;
        try {
          parsed = JSON.parse(line.text);
        } catch {
          return false;
        }
        parsedLineCount += 1;
        recordCommandOutcome(parsed, outcomesByCallId);
        let row = parseCommandCall(parsed, outcomesByCallId);
        let kind = "command";
        if (!row) {
          row = parseSessionMessageFromResponseItem(parsed);
          kind = "message";
        }
        if (row) {
          const logicalFingerprint = fingerprint([row.role, row.at, row.content, row.commandExecution?.command || ""]);
          if (!primaryFingerprints.has(logicalFingerprint)) {
            primaryFingerprints.add(logicalFingerprint);
            row.itemId = rowId(row, kind);
            if (header.isSubagent && header.boundaryTimestamp && String(row.at || "") < header.boundaryTimestamp) {
              row.inheritedFromParent = true;
            }
            primaryRows.push({ row, start });
          }
          return primaryRows.length > limit;
        }
        const fallback = parseSessionMessageFromEventItem(parsed);
        if (fallback) fallbackRows.push({ row: fallback, start });
        return false;
      });
      const availableRows = [...primaryRows];
      if (availableRows.length <= limit && scan.reachedStart) {
        for (const candidate of fallbackRows) {
          const logicalFingerprint = fingerprint([candidate.row.role, candidate.row.at, candidate.row.content, ""]);
          if (primaryFingerprints.has(logicalFingerprint)) continue;
          primaryFingerprints.add(logicalFingerprint);
          candidate.row.itemId = rowId(candidate.row, "message");
          availableRows.push(candidate);
          if (availableRows.length > limit) break;
        }
      }
      const selected = availableRows.slice(0, limit).sort((left, right) => left.start - right.start);
      const oldestStart = selected[0]?.start ?? 0;
      const olderCursor = oldestStart > 0 && (!scan.reachedStart || availableRows.length > limit)
        ? Buffer.from(JSON.stringify({
          v: CURSOR_VERSION,
          sessionId,
          end: oldestStart,
          dev: String(stat.dev),
          ino: String(stat.ino),
          boundaryHash: await hashBoundary(handle, oldestStart, fileSize),
        }), "utf8").toString("base64url")
        : null;
      return {
        messages: selected.map((item) => item.row),
        olderCursor,
        isSubagent: header.isSubagent,
        parentSessionId: header.parentSessionId,
        workingDirectory: header.workingDirectory,
        diagnostics: {
          totalMs: Math.max(0, Date.now() - startedAt),
          startOffset: oldestStart,
          endOffset,
          bytesRead: scan.bytesRead,
          scannedLineCount,
          parsedLineCount,
          oversizedLineCount,
          messageCount: selected.length,
        },
      };
    } finally {
      await handle.close().catch(() => {});
    }
  };
}
