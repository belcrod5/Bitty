import {
  LOCATION_REGION_PREFIX,
  appendPendingLocationState,
  enabledLocationRegions,
  isCoordinateInsideRule,
  locationRuleRevision,
  parseLocationRegionIdentifier,
  parseLocationScheduleRules,
  pendingLocationStatesForRules,
  regionIdentifierForRule,
  scheduleRuleRevision,
  removeSentPendingLocationStates,
} from "./locationScheduleRules";

const models = [{ value: "gpt-5.6-sol" }];
const validRule = {
  id: "office",
  enabled: true,
  startTime: "09:00",
  endTime: "10:00",
  timeZone: "Asia/Tokyo",
  latitude: 35.6812,
  longitude: 139.7671,
  radiusMeters: 200,
  cwd: "/work/project",
  modelRef: "openai-codex/gpt-5.6-sol",
  reasoningEffort: "high",
  prompt: "run checks",
};

test("parses schedules with the normal normalized model values", () => {
  expect(parseLocationScheduleRules([validRule], models)).toEqual([
    expect.objectContaining({ modelRef: "gpt-5.6-sol", reasoningEffort: "high" }),
  ]);
  expect(parseLocationScheduleRules([{ ...validRule, modelRef: "unknown" }], models)).toEqual([]);
  expect(parseLocationScheduleRules([{ ...validRule, endTime: "08:00" }], models)).toEqual([]);
});

test("reconciles enabled rules to one geofence each and enforces the iOS limit", () => {
  const rules = parseLocationScheduleRules([validRule], models);
  expect(enabledLocationRegions(rules)).toEqual([
    expect.objectContaining({ identifier: regionIdentifierForRule(rules[0]), radius: 200 }),
  ]);
  expect(parseLocationRegionIdentifier(regionIdentifierForRule(rules[0]))).toEqual({
    ruleId: "office",
    regionRevision: locationRuleRevision(rules[0]),
    scheduleRevision: scheduleRuleRevision(rules[0]),
  });
  expect(parseLocationRegionIdentifier(`${LOCATION_REGION_PREFIX}office:${locationRuleRevision(rules[0])}`)).toEqual({
    ruleId: "office",
    regionRevision: locationRuleRevision(rules[0]),
    scheduleRevision: "",
  });
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ ...rules[0], id: `rule_${index}` }));
  expect(() => enabledLocationRegions(tooMany)).toThrow(/20/);
});

test("calculates initial inside state without waiting for an enter event", () => {
  expect(isCoordinateInsideRule({ latitude: validRule.latitude, longitude: validRule.longitude }, validRule)).toBe(true);
  expect(isCoordinateInsideRule({ latitude: 35.7, longitude: 139.8 }, validRule)).toBe(false);
});

test("background pending event queue is bounded and idempotent by event id", () => {
  const event = { ruleId: "office", regionRevision: "revision-a", scheduleRevision: "schedule-a", state: "inside" as const, eventId: "event-1", observedAt: "2026-07-19T00:00:00Z" };
  expect(appendPendingLocationState([], event)).toEqual([event]);
  expect(appendPendingLocationState([event], event)).toEqual([event]);
  const many = Array.from({ length: 205 }, (_, index) => ({ ...event, ruleId: `rule-${index}`, eventId: `event-${index}` }));
  expect(appendPendingLocationState(many, { ...event, eventId: "last" })).toHaveLength(200);
});

test("pending state converges to each rule's latest observation before sync", () => {
  const revision = locationRuleRevision(validRule);
  const scheduleRevision = scheduleRuleRevision(parseLocationScheduleRules([validRule], models)[0]);
  const inside = { ruleId: "office", regionRevision: revision, scheduleRevision, state: "inside" as const, eventId: "inside", observedAt: "2026-07-19T00:00:00Z" };
  const outside = { ...inside, state: "outside" as const, eventId: "outside", observedAt: "2026-07-19T00:01:00Z" };
  expect(appendPendingLocationState([inside], outside)).toEqual([outside]);
  expect(appendPendingLocationState([outside], { ...inside, eventId: "old-inside" })).toEqual([outside]);
  const nextInside = { ...inside, eventId: "next-inside", observedAt: "2026-07-19T00:02:00Z" };
  expect(appendPendingLocationState([outside], nextInside)).toEqual([nextInside]);
  expect(removeSentPendingLocationStates([inside, outside], new Set([outside.eventId]))).toEqual([]);
});

test("location and schedule revisions invalidate pending state and monitored identifiers", () => {
  const parsed = parseLocationScheduleRules([validRule], models)[0];
  const revision = locationRuleRevision(parsed);
  const nonLocationEdit = { ...parsed, prompt: "different", modelRef: "different", startTime: "11:00" };
  expect(locationRuleRevision(nonLocationEdit)).toBe(revision);
  expect(regionIdentifierForRule(nonLocationEdit)).not.toBe(regionIdentifierForRule(parsed));
  const moved = { ...parsed, latitude: parsed.latitude + 0.001 };
  expect(locationRuleRevision(moved)).not.toBe(revision);
  const oldEvent = { ruleId: parsed.id, regionRevision: revision, scheduleRevision: scheduleRuleRevision(parsed), state: "inside" as const, eventId: "old", observedAt: "2026-07-19T00:00:00Z" };
  expect(pendingLocationStatesForRules([oldEvent], [moved])).toEqual([]);
  expect(pendingLocationStatesForRules([oldEvent], [{ ...parsed, prompt: "different" }])).toEqual([]);
  expect(pendingLocationStatesForRules([oldEvent], [parsed])).toEqual([oldEvent]);
});
