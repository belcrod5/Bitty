import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

const CURSOR_VERSION = 1;
const CHUNK_BYTES = 64 * 1024;
const MAX_JSON_LINE_BYTES = 256 * 1024;
const CURSOR_HASH_BYTES = 128;
const MESSAGE_PAIR_LOOKAROUND_RECORDS = 32;
// A command outcome appended past the delta boundary must repair its call row
// even when the call sits far before the boundary, so the delta lookbehind may
// extend beyond the message-pair window — but never past this safety cap.
const DELTA_OUTCOME_LOOKBEHIND_MAX_RECORDS = 2048;

export function createLlmSessionHistoryPageReader(deps) {
  const {
    makeApiError,
    normalizeSessionMessagesLimit,
    normalizeSessionUpdatedAt,
    parseSessionMessageFromEventItem,
    parseSessionResponseItem,
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

  function resolveMessageCandidates(candidates, scannedLineCount, reachedStart) {
    const resolved = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const older = candidates[index + 1];
      const pair = older
        && candidate.pairRole
        && candidate.pairRole === older.pairRole
        && candidate.source !== older.source
        && candidate.source !== "other"
        && older.source !== "other"
        && candidate.row.content === older.row.content
        && Math.abs(candidate.recordIndex - older.recordIndex) <= MESSAGE_PAIR_LOOKAROUND_RECORDS;
      if (pair) {
        const response = candidate.source === "response_message" ? candidate : older;
        resolved.push({
          row: response.row,
          start: Math.min(candidate.start, older.start),
          end: Math.max(candidate.lineEnd || 0, older.lineEnd || 0),
          latestRecordEnd: Math.max(
            candidate.lineEnd || 0,
            older.lineEnd || 0,
            candidate.outcomeEnd || 0,
            older.outcomeEnd || 0
          ),
          pairOlderRowId: older.row.itemId,
          confirmed: true,
        });
        index += 1;
        continue;
      }
      const row = candidate.source === "response_message"
        && candidate.pairRole === "user"
        && !candidate.confirmedUserText
        ? { ...candidate.row, role: "assistant", kind: "unclassified_context" }
        : candidate.row;
      resolved.push({
        row,
        start: candidate.start,
        end: candidate.lineEnd || 0,
        latestRecordEnd: Math.max(candidate.lineEnd || 0, candidate.outcomeEnd || 0),
        confirmed: (
          reachedStart
          || !candidate.pairRole
          || older !== undefined
          || scannedLineCount - candidate.recordIndex >= MESSAGE_PAIR_LOOKAROUND_RECORDS
        ),
      });
    }
    return resolved;
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

  function recordCommandOutcome(parsed, outcomesByCallId, recordEnd = 0) {
    if (String(parsed?.type || "") !== "response_item") return "";
    const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
    const payloadType = String(payload?.type || "").trim().toLowerCase();
    if (!payload || (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output")) return "";
    const callId = String(payload?.call_id || payload?.callId || payload?.id || "").trim();
    if (!callId) return "";
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
      end: Math.max(0, Number(recordEnd) || 0),
    });
    return callId;
  }

  function recordOversizedCommandOutcome(line, outcomesByCallId, recordEnd = 0) {
    const prefix = String(line?.prefix || "");
    const suffix = String(line?.suffix || "");
    const sampled = `${prefix}\n${suffix}`;
    if (!/"type"\s*:\s*"(?:function_call_output|custom_tool_call_output)"/.test(sampled)) {
      return { isOutcome: false, callId: "" };
    }
    const callId = sampled.match(/"(?:call_id|callId)"\s*:\s*"([^"\\]+)"/)?.[1] || "";
    if (!callId) return { isOutcome: true, callId: "" };
    const exitCodeText = sampled.match(/(?:exit_code|exitCode)[\\"']*\s*[:=]\s*(-?\d+)/)?.[1];
    const exitCode = Number(exitCodeText);
    outcomesByCallId.set(callId, {
      status: Number.isFinite(exitCode) && exitCode !== 0 ? "failed" : "completed",
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      end: Math.max(0, Number(recordEnd) || 0),
    });
    return { isOutcome: true, callId };
  }

  function oversizedRecordPlaceholder(line) {
    const prefix = String(line?.prefix || "");
    const suffix = String(line?.suffix || "");
    const sampled = `${prefix}\n${suffix}`;
    const responseMessage = (
      /"type"\s*:\s*"response_item"/.test(sampled)
      && /"type"\s*:\s*"message"/.test(sampled)
    );
    const eventMessageType = sampled.match(/"type"\s*:\s*"(user_message|agent_message)"/)?.[1] || "";
    const eventMessage = /"type"\s*:\s*"event_msg"/.test(sampled) && Boolean(eventMessageType);
    if (!responseMessage && !eventMessage) return null;
    const responseRole = sampled.match(/"role"\s*:\s*"(user|assistant)"/)?.[1] || "";
    const pairRole = responseMessage
      ? responseRole
      : eventMessageType === "user_message"
        ? "user"
        : "assistant";
    const byteLength = Math.max(0, Number(line?.byteLength || 0));
    return {
      row: {
        role: "assistant",
        content: "大きな履歴メッセージの本文は省略されています。",
        at: "",
        kind: "unclassified_context",
        itemId: `history-oversized-${fingerprint([String(byteLength), prefix, suffix])}`,
      },
      source: responseMessage ? "response_message" : "event_message",
      pairRole,
    };
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

  // Hash only the bytes right before the boundary: rollouts are append-only, so
  // this keeps a cursor issued at EOF valid after new records are appended.
  async function hashBoundary(handle, endOffset) {
    const start = Math.max(0, endOffset - CURSOR_HASH_BYTES);
    const buffer = Buffer.alloc(Math.max(0, endOffset - start));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    return fingerprint([String(endOffset), buffer.toString("base64")]);
  }

  async function encodePositionCursor(handle, stat, sessionId, end) {
    return Buffer.from(JSON.stringify({
      v: CURSOR_VERSION,
      sessionId,
      end,
      dev: String(stat.dev),
      ino: String(stat.ino),
      boundaryHash: await hashBoundary(handle, end),
    }), "utf8").toString("base64url");
  }

  async function requireValidCursor(rawCursor, sessionId, handle, stat, fileSize) {
    const cursor = decodeCursor(rawCursor, sessionId);
    if (
      String(cursor.dev) !== String(stat.dev)
      || String(cursor.ino) !== String(stat.ino)
      || cursor.end > fileSize
      || cursor.boundaryHash !== await hashBoundary(handle, cursor.end)
    ) {
      throw makeApiError(409, "stale_history_cursor", "履歴が更新されたため、セッションを開き直してください");
    }
    return cursor;
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
    const sinceCursorRaw = String(opts?.sinceCursor || "").trim();
    let handle;
    try {
      handle = await fs.open(filePath, "r");
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "ENOENT") throw error;
      if (sinceCursorRaw) {
        throw makeApiError(409, "stale_history_cursor", "履歴が更新されたため、セッションを開き直してください");
      }
      return {
        messages: [],
        olderCursor: null,
        latestCursor: null,
        diagnostics: { totalMs: Math.max(0, Date.now() - startedAt), bytesRead: 0, parsedLineCount: 0 },
      };
    }
    try {
      const stat = await handle.stat();
      const fileSize = Number(stat.size || 0);
      let endOffset = fileSize;
      if (opts?.cursor) {
        const cursor = await requireValidCursor(opts.cursor, sessionId, handle, stat, fileSize);
        endOffset = cursor.end;
      }
      // Forward-delta mode: return only rows past the previously issued cursor.
      let sinceOffset = -1;
      if (sinceCursorRaw) {
        const sinceCursor = await requireValidCursor(sinceCursorRaw, sessionId, handle, stat, fileSize);
        sinceOffset = sinceCursor.end;
      }
      const deltaMode = sinceOffset >= 0;
      const header = await readSessionHeaderContext(filePath, stat);
      const outcomesByCallId = new Map();
      const candidates = [];
      let parsedLineCount = 0;
      let oversizedLineCount = 0;
      let oversizedMessageCount = 0;
      let scannedLineCount = 0;
      let lookbehindLineCount = 0;
      let nextNewerLineStart = endOffset;
      const hasConfirmedPage = () => {
        const resolved = resolveMessageCandidates(candidates, scannedLineCount, false);
        return resolved.length > limit && resolved.slice(0, limit + 1).every((item) => item.confirmed);
      };
      // Command outcomes appended past the boundary whose call row has not been
      // seen yet: the lookbehind keeps scanning until each call is found (or the
      // safety cap is hit), so the repaired row can be re-sent to the client.
      const pendingOutcomeCallIds = new Set();
      const trackDeltaOutcome = (callId, start) => {
        if (deltaMode && callId && start >= sinceOffset) pendingOutcomeCallIds.add(callId);
      };
      // In delta mode the scan must cover the whole appended range plus the pair
      // lookaround window right before the boundary, so it cannot stop earlier.
      const shouldStopScan = () => (deltaMode
        ? (
          lookbehindLineCount >= MESSAGE_PAIR_LOOKAROUND_RECORDS
          && (pendingOutcomeCallIds.size === 0 || lookbehindLineCount >= DELTA_OUTCOME_LOOKBEHIND_MAX_RECORDS)
        )
        : hasConfirmedPage());
      const scan = await scanLinesBackward(handle, endOffset, (line, start) => {
        scannedLineCount += 1;
        const lineEnd = nextNewerLineStart;
        nextNewerLineStart = start;
        if (deltaMode && start < sinceOffset) lookbehindLineCount += 1;
        if (line.oversized) {
          oversizedLineCount += 1;
          const oversizedOutcome = recordOversizedCommandOutcome(line, outcomesByCallId, lineEnd);
          trackDeltaOutcome(oversizedOutcome.callId, start);
          const placeholder = oversizedOutcome.isOutcome ? null : oversizedRecordPlaceholder(line);
          if (placeholder) {
            oversizedMessageCount += 1;
            candidates.push({
              row: placeholder.row,
              start,
              lineEnd,
              source: placeholder.source,
              pairRole: placeholder.pairRole,
              recordIndex: scannedLineCount,
            });
          }
          return shouldStopScan();
        }
        if (!line.text.trim()) return shouldStopScan();
        let parsed;
        try {
          parsed = JSON.parse(line.text);
        } catch {
          return shouldStopScan();
        }
        parsedLineCount += 1;
        trackDeltaOutcome(recordCommandOutcome(parsed, outcomesByCallId, lineEnd), start);
        let row = parseCommandCall(parsed, outcomesByCallId);
        let kind = row ? "command" : "message";
        let source = row ? "other" : "";
        let pairRole = "";
        let confirmedUserText = false;
        if (!row) {
          const responseItem = parseSessionResponseItem(parsed);
          row = responseItem?.message || null;
          pairRole = responseItem?.pairRole || "";
          confirmedUserText = responseItem?.confirmedUserText === true;
          if (row) source = pairRole ? "response_message" : "other";
        }
        if (!row) {
          row = parseSessionMessageFromEventItem(parsed);
          if (row) {
            source = "event_message";
            pairRole = row.role;
          }
        }
        if (!row) return shouldStopScan();
        row.itemId = rowId(row, kind);
        const outcomeEnd = kind === "command"
          ? Math.max(0, Number(outcomesByCallId.get(String(row.itemId || ""))?.end || 0))
          : 0;
        if (kind === "command") pendingOutcomeCallIds.delete(String(row.itemId || ""));
        candidates.push({
          row,
          start,
          lineEnd,
          outcomeEnd,
          source,
          pairRole,
          confirmedUserText,
          recordIndex: scannedLineCount,
        });
        return shouldStopScan();
      });
      const availableRows = resolveMessageCandidates(candidates, scannedLineCount, scan.reachedStart);
      for (const item of availableRows) {
        if (
          header.isSubagent
          && header.boundaryTimestamp
          && String(item.row.at || "") < header.boundaryTimestamp
        ) {
          item.row.inheritedFromParent = true;
        }
      }
      if (deltaMode) {
        const ascending = [...availableRows].sort((left, right) => left.start - right.start);
        const freshRows = [];
        const replacedRows = [];
        for (const item of ascending) {
          if ((item.latestRecordEnd || 0) <= sinceOffset) continue;
          if (item.start >= sinceOffset) {
            freshRows.push(item);
            continue;
          }
          // The row starts before the boundary but a record past the boundary
          // (pair partner or command outcome) changed its resolution: re-send it
          // so the client can replace its cached copy by itemId. When the pair
          // resolution changed the row id, expose the superseded id explicitly.
          const row = item.pairOlderRowId && item.pairOlderRowId !== item.row.itemId
            ? { ...item.row, replacesItemId: item.pairOlderRowId }
            : item.row;
          replacedRows.push({ ...item, row });
        }
        const moreAfter = freshRows.length > limit;
        const selectedFresh = freshRows.slice(0, limit);
        const selected = [...replacedRows, ...selectedFresh];
        const latestEnd = moreAfter ? selectedFresh[selectedFresh.length - 1].end : fileSize;
        const latestCursor = await encodePositionCursor(handle, stat, sessionId, latestEnd);
        return {
          messages: selected.map((item) => item.row),
          olderCursor: null,
          latestCursor,
          moreAfter,
          isSubagent: header.isSubagent,
          parentSessionId: header.parentSessionId,
          workingDirectory: header.workingDirectory,
          diagnostics: {
            totalMs: Math.max(0, Date.now() - startedAt),
            startOffset: sinceOffset,
            endOffset,
            bytesRead: scan.bytesRead,
            scannedLineCount,
            parsedLineCount,
            oversizedLineCount,
            oversizedMessageCount,
            messageCount: selected.length,
          },
        };
      }
      const selected = availableRows.slice(0, limit).sort((left, right) => left.start - right.start);
      const oldestStart = selected[0]?.start ?? 0;
      const olderCursor = oldestStart > 0 && (!scan.reachedStart || availableRows.length > limit)
        ? await encodePositionCursor(handle, stat, sessionId, oldestStart)
        : null;
      // Contract: latestCursor always marks EOF at read time (also on older
      // pages), so any response can seed a later sinceCursor delta.
      const latestCursor = await encodePositionCursor(handle, stat, sessionId, fileSize);
      return {
        messages: selected.map((item) => item.row),
        olderCursor,
        latestCursor,
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
          oversizedMessageCount,
          messageCount: selected.length,
        },
      };
    } finally {
      await handle.close().catch(() => {});
    }
  };
}
