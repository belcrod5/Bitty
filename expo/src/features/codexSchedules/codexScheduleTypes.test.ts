import {
  CODEX_SCHEDULE_REPEAT_OPTIONS,
  codexScheduleDefinitionOnly,
  codexScheduleRepeatToRrule,
  codexScheduleRruleToRepeat,
  codexScheduleStartLocalFromDate,
  parseCodexScheduleDefinition,
  parseCodexScheduleSnapshot,
  type CodexSchedule,
} from "./codexScheduleTypes";

const definition = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning",
  enabled: true,
  startLocal: "2026-08-14T09:00:00",
  timeZone: "Asia/Tokyo",
  rrule: "FREQ=DAILY" as const,
  cwd: "/work/project",
  modelRef: "openai-codex/gpt-5.6",
  reasoningEffort: "high" as const,
  prompt: "Check the project",
};

test("strict parser accepts the complete snapshot and rejects unknown or invalid values", () => {
  const snapshot = parseCodexScheduleSnapshot({
    ok: true,
    revision: 4,
    schedules: [{ ...definition, nextOccurrenceAt: "2026-08-14T00:00:00.000Z", lastDispatch: null }],
  });
  expect(snapshot.revision).toBe(4);
  expect(snapshot.schedules[0].timeZone).toBe("Asia/Tokyo");
  expect(snapshot.schedules[0].threadId).toBeNull();
  expect(parseCodexScheduleDefinition({ ...definition, threadId: "thread:current" }).threadId).toBe("thread:current");
  expect(() => parseCodexScheduleDefinition({ ...definition, threadId: "not a thread" })).toThrow("threadId");
  expect(() => parseCodexScheduleDefinition({ ...definition, extra: true })).toThrow("unknown field");
  expect(() => parseCodexScheduleDefinition({ ...definition, startLocal: " 2026-08-14T09:00:00" })).toThrow("startLocal");
  expect(() => parseCodexScheduleDefinition({ ...definition, timeZone: "Not/AZone" })).toThrow("timeZone");
  expect(() => parseCodexScheduleDefinition({ ...definition, reasoningEffort: "never" })).toThrow("reasoningEffort");
  expect(() => parseCodexScheduleSnapshot({ ok: true, revision: 0, schedules: [
    { ...definition, nextOccurrenceAt: null, lastDispatch: null },
    { ...definition, nextOccurrenceAt: null, lastDispatch: null },
  ] })).toThrow("duplicate");
});

test.each(["max", "ultra"] as const)("strict parser accepts the shared %s reasoning effort", (reasoningEffort) => {
  expect(parseCodexScheduleDefinition({ ...definition, reasoningEffort }).reasoningEffort).toBe(reasoningEffort);
});

test("dispatch parser enforces Runner hash, error, and status invariants", () => {
  const dispatch = {
    occurrenceAt: "2026-08-14T00:00:00.000Z",
    claimedAt: "2026-08-14T00:00:00.000Z",
    definitionHash: "a".repeat(64),
    status: "failed",
    threadId: null,
    turnId: null,
    errorCode: "failed",
    errorMessage: "failure",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  const snapshot = (lastDispatch: Record<string, unknown>) => ({
    ok: true,
    revision: 1,
    schedules: [{ ...definition, nextOccurrenceAt: null, lastDispatch }],
  });
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, definitionHash: "a".repeat(63) }))).toThrow("definitionHash");
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, definitionHash: "G".repeat(64) }))).toThrow("definitionHash");
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, errorCode: "x".repeat(201) }))).toThrow("errorCode");
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, status: "fired", threadId: null, turnId: null }))).toThrow("fired IDs");
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, status: "claimed", threadId: "thread", turnId: null }))).toThrow("claimed IDs");
  expect(parseCodexScheduleSnapshot(snapshot({ ...dispatch, status: "failed", threadId: "known-thread", turnId: null })).schedules[0].lastDispatch?.threadId).toBe("known-thread");
});

test("all repeat choices map to and from their canonical RRULE", () => {
  expect(CODEX_SCHEDULE_REPEAT_OPTIONS.map((option) => option.value)).toEqual([
    "none", "daily", "weekly", "monthly", "yearly",
  ]);
  for (const option of CODEX_SCHEDULE_REPEAT_OPTIONS) {
    expect(codexScheduleRruleToRepeat(codexScheduleRepeatToRrule(option.value))).toBe(option.value);
  }
});

test("definition-only wire shape removes runtime fields and local dates keep minute precision", () => {
  const schedule: CodexSchedule = { ...definition, threadId: null, nextOccurrenceAt: null, lastDispatch: null };
  expect(codexScheduleDefinitionOnly(schedule)).toEqual({ ...definition, threadId: null });
  expect(codexScheduleStartLocalFromDate(new Date(2026, 7, 14, 9, 7, 51))).toBe("2026-08-14T09:07:00");
});
