import {
  codexScheduleDefinitionOnly,
  parseCodexScheduleSnapshot,
  type CodexSchedule,
  type CodexScheduleSnapshot,
} from "./codexScheduleTypes";

export class CodexScheduleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly revision: number | null;

  constructor(message: string, status: number, code: string, revision: number | null = null) {
    super(message);
    this.name = "CodexScheduleApiError";
    this.status = status;
    this.code = code;
    this.revision = revision;
  }
}

type Auth = { runnerUrl: string; runnerToken: string };

async function request(auth: Auth, init?: RequestInit): Promise<CodexScheduleSnapshot> {
  const runnerUrl = String(auth.runnerUrl || "").trim().replace(/\/+$/, "");
  const runnerToken = String(auth.runnerToken || "").trim();
  if (!runnerUrl || !runnerToken) throw new CodexScheduleApiError("Runnerへ接続する設定がありません。", 0, "runner_unavailable");
  const response = await fetch(`${runnerUrl}/codex-schedules`, {
    ...init,
    headers: {
      authorization: `Bearer ${runnerToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CodexScheduleApiError("Runnerから不正な応答を受信しました。", response.status, "invalid_response");
  }
  if (!response.ok) {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const code = typeof body.error === "string" ? body.error : "codex_schedule_request_failed";
    const message = typeof body.message === "string" ? body.message : `Runner request failed (${response.status})`;
    const revision = Number.isInteger(body.revision) ? Number(body.revision) : null;
    throw new CodexScheduleApiError(message, response.status, code, revision);
  }
  return parseCodexScheduleSnapshot(payload);
}

export function getCodexSchedules(auth: Auth): Promise<CodexScheduleSnapshot> {
  return request(auth);
}

export function putCodexSchedules(
  auth: Auth,
  baseRevision: number,
  schedules: readonly CodexSchedule[],
): Promise<CodexScheduleSnapshot> {
  return request(auth, {
    method: "PUT",
    body: JSON.stringify({
      baseRevision,
      schedules: schedules.map(codexScheduleDefinitionOnly),
    }),
  });
}
