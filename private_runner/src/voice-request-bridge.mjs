import { randomUUID } from "node:crypto";
import { isValidUserInputResponse } from "./codex-user-input.mjs";
import { CALENDAR_DYNAMIC_TOOLS_NAMESPACE, CALENDAR_READ_TOOL_NAMES } from "./calendar-tool-service.mjs";

function calendarResponse(result) {
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
}

function calendarFailure(code) {
  return calendarResponse({ ok: false, error: { code, retryable: false, message: {
    invalid_arguments: "入力内容が正しくありません。",
    device_unavailable: "カレンダー端末に接続できません。",
    request_cancelled: "カレンダー要求はキャンセルされました。",
  }[code] } });
}

export function createVoiceRequestBridge({ send, onResolved, timeoutMs = 2 * 60 * 1000 }) {
  const pending = new Map();
  let closed = false;

  return {
    request(operationId, { method, params, threadId, turnId, startedAtMs = Date.now() }, orchestratorId = "main", orchestratorName = "", signal) {
      const question = method === "item/tool/requestUserInput";
      const calendar = method === "item/tool/call";
      if (calendar && (params?.namespace !== CALENDAR_DYNAMIC_TOOLS_NAMESPACE
        || !CALENDAR_READ_TOOL_NAMES.includes(params?.tool))) return Promise.resolve(calendarFailure("invalid_arguments"));
      if (question && Date.now() >= startedAtMs + 60_000) return Promise.resolve({ answers: {} });
      if (calendar && (closed || signal?.aborted)) {
        return Promise.resolve(calendarFailure(signal?.aborted ? "request_cancelled" : "device_unavailable"));
      }
      if (calendar && Date.now() >= startedAtMs + 30_000) return Promise.resolve(calendarFailure("device_unavailable"));
      if (closed || signal?.aborted) return question ? Promise.resolve({ answers: {} })
        : Promise.reject(new Error("Voice approval channel closed"));
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        let announced = false;
        const finish = (value, error) => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (announced) {
            try { onResolved?.({ requestId, operationId, orchestratorId, method }); } catch {}
          }
          if (calendar) resolve(error ? calendarFailure("device_unavailable") : value);
          else if (error && !question) reject(error);
          else resolve(question && error ? { answers: {} } : value);
        };
        const abort = () => calendar ? finish(calendarFailure("request_cancelled"))
          : finish({ answers: {} }, new Error("Voice approval cancelled"));
        const calendarDeadline = startedAtMs + 30_000;
        const timer = setTimeout(() => finish({ answers: {} }, new Error("Voice approval timed out")),
          calendar ? Math.max(0, calendarDeadline - Date.now())
            : question ? Math.max(0, startedAtMs + 60_000 - Date.now()) : timeoutMs);
        pending.set(requestId, { operationId, question, calendar, params, startedAtMs, calendarDeadline, finish });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (send({ requestId, operationId, method, params, threadId, turnId, orchestratorId, orchestratorName,
            ...(question || calendar ? { startedAtMs } : {}) }) !== true) {
            throw new Error("Voice approval channel closed");
          }
          announced = true;
        } catch (error) {
          finish({ answers: {} }, error);
        }
      });
    },
    decide(operationId, requestId, decision) {
      const entry = pending.get(requestId);
      if (!entry || entry.question || entry.calendar || entry.operationId !== operationId
        || !["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return false;
      entry.finish(decision, decision === "cancel" ? new Error("Voice approval cancelled") : null);
      return true;
    },
    respond(operationId, requestId, result) {
      const entry = pending.get(requestId);
      if (entry?.calendar && entry.operationId === operationId) {
        if (Date.now() >= entry.calendarDeadline) {
          entry.finish(calendarFailure("device_unavailable"));
          return false;
        }
        if (!result || typeof result !== "object" || Array.isArray(result)
          || (result.ok === true ? !Object.hasOwn(result, "data")
            : result.ok !== false || !result.error || typeof result.error !== "object"
              || typeof result.error.code !== "string" || typeof result.error.message !== "string"
              || typeof result.error.retryable !== "boolean")) return false;
        entry.finish(calendarResponse(result));
        return true;
      }
      if (!entry?.question || entry.operationId !== operationId) return false;
      if (Date.now() >= entry.startedAtMs + 60_000) {
        entry.finish({ answers: {} });
        return false;
      }
      if (!isValidUserInputResponse(entry.params, result)) return false;
      entry.finish({ answers: result.answers });
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        entry.finish({ answers: {} }, new Error("Voice approval channel closed"));
      }
      pending.clear();
    },
  };
}
