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
  action: {
    kind: "llm" as const,
    cwd: "/work/project",
    modelRef: "openai-codex/gpt-5.6",
    reasoningEffort: "high" as const,
    prompt: "Check the project",
    threadId: null,
  },
};

test("strict parser accepts the complete snapshot and rejects unknown or invalid values", () => {
  const snapshot = parseCodexScheduleSnapshot({
    ok: true,
    revision: 4,
    schedules: [{ ...definition, nextOccurrenceAt: "2026-08-14T00:00:00.000Z", lastDispatch: null }],
  });
  expect(snapshot.revision).toBe(4);
  expect(snapshot.schedules[0].timeZone).toBe("Asia/Tokyo");
  expect(snapshot.schedules[0].action).toEqual(expect.objectContaining({ kind: "llm", threadId: null }));
  expect(parseCodexScheduleDefinition({ ...definition, action: { ...definition.action, threadId: "thread:current" } }).action).toEqual(expect.objectContaining({ threadId: "thread:current" }));
  expect(() => parseCodexScheduleDefinition({ ...definition, action: { ...definition.action, threadId: "not a thread" } })).toThrow("threadId");
  expect(() => parseCodexScheduleDefinition({ ...definition, extra: true })).toThrow("unknown field");
  expect(() => parseCodexScheduleDefinition({ ...definition, startLocal: " 2026-08-14T09:00:00" })).toThrow("startLocal");
  expect(() => parseCodexScheduleDefinition({ ...definition, timeZone: "Not/AZone" })).toThrow("timeZone");
  expect(() => parseCodexScheduleDefinition({ ...definition, action: { ...definition.action, reasoningEffort: "never" } })).toThrow("reasoningEffort");
  expect(() => parseCodexScheduleSnapshot({ ok: true, revision: 0, schedules: [
    { ...definition, nextOccurrenceAt: null, lastDispatch: null },
    { ...definition, nextOccurrenceAt: null, lastDispatch: null },
  ] })).toThrow("duplicate");
});

test.each(["max", "ultra"] as const)("strict parser accepts the shared %s reasoning effort", (reasoningEffort) => {
  expect(parseCodexScheduleDefinition({ ...definition, action: { ...definition.action, reasoningEffort } }).action).toEqual(expect.objectContaining({ reasoningEffort }));
});

test("definition parser accepts script actions and converts the legacy LLM shape", () => {
  expect(parseCodexScheduleDefinition({
    ...definition,
    action: { kind: "script", cwd: "/work/project", scriptPath: "/work/project/run.sh" },
  }).action).toEqual({ kind: "script", cwd: "/work/project", scriptPath: "/work/project/run.sh" });
  const { action, ...base } = definition;
  const { kind: _kind, ...legacyAction } = action;
  expect(parseCodexScheduleDefinition({ ...base, ...legacyAction }).action).toEqual(action);
  expect(() => parseCodexScheduleDefinition({
    ...definition,
    action: { kind: "script", cwd: "/work/project", scriptPath: "/work/project/run.py" },
  })).toThrow("scriptPath");
});

test("dispatch parser enforces Runner hash, error, and status invariants", () => {
  const dispatch = {
    occurrenceAt: "2026-08-14T00:00:00.000Z",
    claimedAt: "2026-08-14T00:00:00.000Z",
    definitionHash: "a".repeat(64),
    status: "failed",
    result: null,
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
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, status: "fired" }))).toThrow("fired result");
  expect(() => parseCodexScheduleSnapshot(snapshot({
    ...dispatch,
    status: "fired",
    result: { kind: "llm", threadId: "known-thread", turnId: null },
  }))).toThrow("fired LLM IDs");
  expect(() => parseCodexScheduleSnapshot(snapshot({ ...dispatch, status: "claimed", result: { kind: "script", jobId: "job" } }))).toThrow("claimed result");
  expect(parseCodexScheduleSnapshot(snapshot({
    ...dispatch,
    status: "failed",
    result: { kind: "llm", threadId: "known-thread", turnId: null },
  })).schedules[0].lastDispatch?.result).toEqual({ kind: "llm", threadId: "known-thread", turnId: null });
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
  const schedule: CodexSchedule = { ...definition, nextOccurrenceAt: null, lastDispatch: null };
  expect(codexScheduleDefinitionOnly(schedule)).toEqual(definition);
  expect(codexScheduleStartLocalFromDate(new Date(2026, 7, 14, 9, 7, 51))).toBe("2026-08-14T09:07:00");
});
