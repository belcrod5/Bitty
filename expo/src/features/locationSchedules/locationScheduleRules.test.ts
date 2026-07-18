import {
  appendPendingLocationState,
  enabledLocationRegions,
  isCoordinateInsideRule,
  parseLocationScheduleRules,
  ruleIdFromRegionIdentifier,
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
    expect.objectContaining({ identifier: "bitty-location-schedule:office", radius: 200 }),
  ]);
  expect(ruleIdFromRegionIdentifier("bitty-location-schedule:office")).toBe("office");
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ ...rules[0], id: `rule_${index}` }));
  expect(() => enabledLocationRegions(tooMany)).toThrow(/20/);
});

test("calculates initial inside state without waiting for an enter event", () => {
  expect(isCoordinateInsideRule({ latitude: validRule.latitude, longitude: validRule.longitude }, validRule)).toBe(true);
  expect(isCoordinateInsideRule({ latitude: 35.7, longitude: 139.8 }, validRule)).toBe(false);
});

test("background pending event queue is bounded and idempotent by event id", () => {
  const event = { ruleId: "office", state: "inside" as const, eventId: "event-1", observedAt: "2026-07-19T00:00:00Z" };
  expect(appendPendingLocationState([], event)).toEqual([event]);
  expect(appendPendingLocationState([event], event)).toEqual([event]);
  const many = Array.from({ length: 205 }, (_, index) => ({ ...event, eventId: `event-${index}` }));
  expect(appendPendingLocationState(many, { ...event, eventId: "last" })).toHaveLength(200);
});
