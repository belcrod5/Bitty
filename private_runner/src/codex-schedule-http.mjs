import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
  CODEX_SCHEDULE_UUID_PATTERN,
  CodexScheduleIdempotencyConflictError,
  CodexScheduleNotFoundError,
  CodexScheduleRevisionConflictError,
  CodexScheduleStoreUnavailableError,
} from "./codex-schedule-service.mjs";

const DELETE_BODY_MAX_BYTES = 16 * 1024;

function message(error) {
  return String(error instanceof Error ? error.message : error || "unknown error");
}

export function createCodexScheduleHttpHandler({
  service,
  runnerToken,
  parseAuthToken,
  readJsonBody,
  json,
}) {
  return async function handleCodexSchedules(req, res, pathname) {
    const collection = pathname === "/codex-schedules";
    const rawMemberId = pathname.startsWith("/codex-schedules/")
      ? pathname.slice("/codex-schedules/".length)
      : null;
    const member = rawMemberId !== null && rawMemberId !== "" && !rawMemberId.includes("/");
    if (!collection && !member) return false;

    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return true;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }

    if ((collection && !["GET", "PUT", "POST"].includes(req.method)) ||
      (member && !["PATCH", "DELETE"].includes(req.method))) {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    let id = null;
    if (member) {
      try {
        id = decodeURIComponent(rawMemberId);
      } catch {
        json(res, 400, { error: "invalid_codex_schedule_id" });
        return true;
      }
      if (id.includes("/") || !CODEX_SCHEDULE_UUID_PATTERN.test(id)) {
        json(res, 400, { error: "invalid_codex_schedule_id" });
        return true;
      }
    }

    try {
      if (collection && req.method === "GET") {
        json(res, 200, { ok: true, ...await service.snapshot() });
        return true;
      }
      if (collection && req.method === "PUT") {
        const snapshot = await service.replaceSchedules(
          await readJsonBody(req, CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES),
        );
        json(res, 200, { ok: true, ...snapshot });
        return true;
      }
      if (collection && req.method === "POST") {
        const idempotencyKey = req.headers?.["idempotency-key"];
        if (idempotencyKey === undefined || idempotencyKey === "") {
          json(res, 400, { error: "idempotency_key_required" });
          return true;
        }
        if (Array.isArray(idempotencyKey) || !CODEX_SCHEDULE_UUID_PATTERN.test(idempotencyKey)) {
          json(res, 400, { error: "invalid_idempotency_key" });
          return true;
        }
        const result = await service.createSchedule(
          await readJsonBody(req, CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES),
          idempotencyKey,
        );
        json(res, result.created ? 201 : 200, { ok: true, ...result });
        return true;
      }
      if (req.method === "PATCH") {
        const result = await service.patchSchedule(
          id,
          await readJsonBody(req, CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES),
        );
        json(res, 200, { ok: true, ...result });
        return true;
      }
      const result = await service.deleteSchedule(
        id,
        await readJsonBody(req, DELETE_BODY_MAX_BYTES),
      );
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof CodexScheduleRevisionConflictError) {
        json(res, 409, { error: "revision_conflict", revision: error.revision });
      } else if (error instanceof CodexScheduleIdempotencyConflictError) {
        json(res, 409, {
          error: "idempotency_conflict",
          id: error.id,
          revision: error.revision,
        });
      } else if (error instanceof CodexScheduleNotFoundError) {
        json(res, 404, { error: "codex_schedule_not_found" });
      } else if (error instanceof CodexScheduleStoreUnavailableError) {
        json(res, 503, { error: "codex_schedule_store_unavailable", message: message(error) });
      } else {
        json(res, 400, { error: "invalid_codex_schedules", message: message(error) });
      }
    }
    return true;
  };
}
