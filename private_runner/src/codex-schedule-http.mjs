import {
  CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES,
  CodexScheduleRevisionConflictError,
  CodexScheduleStoreUnavailableError,
} from "./codex-schedule-service.mjs";

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
    if (pathname !== "/codex-schedules") return false;

    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return true;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }

    try {
      if (req.method === "GET") {
        json(res, 200, { ok: true, ...await service.snapshot() });
        return true;
      }
      if (req.method === "PUT") {
        const snapshot = await service.replaceSchedules(
          await readJsonBody(req, CODEX_SCHEDULE_DEFINITIONS_MAX_BYTES),
        );
        json(res, 200, { ok: true, ...snapshot });
        return true;
      }
      json(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (error instanceof CodexScheduleRevisionConflictError) {
        json(res, 409, { error: "revision_conflict", revision: error.revision });
      } else if (error instanceof CodexScheduleStoreUnavailableError) {
        json(res, 503, { error: "codex_schedule_store_unavailable", message: message(error) });
      } else {
        json(res, 400, { error: "invalid_codex_schedules", message: message(error) });
      }
    }
    return true;
  };
}
