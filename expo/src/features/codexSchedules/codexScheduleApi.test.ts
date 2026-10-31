import {
  getCodexSchedules,
  getCodexScheduleSummary,
  putCodexSchedules,
} from "./codexScheduleApi";
import type { CodexSchedule } from "./codexScheduleTypes";

const schedule: CodexSchedule = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning",
  enabled: true,
  startLocal: "2026-08-14T09:00:00",
  timeZone: "Asia/Tokyo",
  rrule: "FREQ=DAILY",
  action: {
    kind: "llm",
    cwd: "/work/project",
    modelRef: "openai-codex/gpt-5.6",
    reasoningEffort: "high",
    prompt: "Check",
    threadId: "thread-current",
  },
  nextOccurrenceAt: "2026-08-14T00:00:00.000Z",
  lastDispatch: null,
};

afterEach(() => jest.restoreAllMocks());

test("GET authenticates and parses the Runner snapshot", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, revision: 2, schedules: [schedule] }),
  } as Response);
  const result = await getCodexSchedules({ runnerUrl: "http://runner/", runnerToken: " token " });
  expect(result.revision).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith("http://runner/codex-schedules", expect.objectContaining({
    headers: { authorization: "Bearer token" },
  }));
});

test("PUT sends only definitions with base revision", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, revision: 3, schedules: [schedule] }),
  } as Response);
  await putCodexSchedules({ runnerUrl: "http://runner", runnerToken: "token" }, 2, [schedule]);
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("PUT");
  const body = JSON.parse(String(init.body));
  expect(body).toEqual({
    baseRevision: 2,
    schedules: [expect.not.objectContaining({ nextOccurrenceAt: expect.anything(), lastDispatch: expect.anything() })],
  });
  expect(body.schedules[0].action.threadId).toBe("thread-current");
});

test("409 exposes the latest revision without hiding the conflict", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ error: "revision_conflict", revision: 8 }),
  } as Response);
  await expect(putCodexSchedules(
    { runnerUrl: "http://runner", runnerToken: "token" },
    2,
    [schedule],
  )).rejects.toEqual(expect.objectContaining({
    code: "revision_conflict",
    status: 409,
    revision: 8,
  }));
});


test("summary GET does not request or retain schedule prompts/dispatch data", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ ok: true, scheduledThreads: [{ threadId: "existing", nextOccurrenceAt: "2026-10-24T00:00:00Z", prompt: "PRIVATE" }] }),
  } as Response);
  expect(await getCodexScheduleSummary({ runnerUrl: "http://runner", runnerToken: "token" })).toEqual({
    scheduledThreads: [{ threadId: "existing", nextOccurrenceAt: "2026-10-24T00:00:00Z" }],
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("http://runner/codex-schedules/summary");
});

test("an older Runner without summary support retains marker compatibility", async () => {
  jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: false, status: 405,
    json: async () => ({ error: "method_not_allowed" }),
  } as Response).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, revision: 1, schedules: [schedule] }) } as Response);
  expect((await getCodexScheduleSummary({ runnerUrl: "http://runner", runnerToken: "token" })).scheduledThreads)
    .toEqual([{ threadId: "thread-current", nextOccurrenceAt: schedule.nextOccurrenceAt }]);
});
