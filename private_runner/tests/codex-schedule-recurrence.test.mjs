import assert from "node:assert/strict";
import test from "node:test";

import {
  codexScheduleOccurrenceAfter,
  codexScheduleOccurrenceAtOrBefore,
} from "../src/codex-schedule-recurrence.mjs";

function schedule(startLocal, timeZone = "UTC", rrule = null) {
  return { startLocal, timeZone, rrule };
}

test("one-time occurrences preserve strict and inclusive boundaries", () => {
  const input = schedule("2026-08-14T09:00:00");
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-08-14T08:59:59.999Z"), "2026-08-14T09:00:00.000Z");
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-08-14T09:00:00.000Z"), null);
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-08-14T09:00:00.000Z", true), "2026-08-14T09:00:00.000Z");
  assert.equal(codexScheduleOccurrenceAtOrBefore(input, "2026-08-14T09:00:00.000Z"), "2026-08-14T09:00:00.000Z");
});

test("daily and weekly retain their local time outside UTC", () => {
  const daily = schedule("2026-08-14T09:00:00", "Asia/Tokyo", "FREQ=DAILY");
  assert.equal(codexScheduleOccurrenceAfter(daily, "2026-08-13T23:59:59.999Z"), "2026-08-14T00:00:00.000Z");
  assert.equal(codexScheduleOccurrenceAfter(daily, "2026-08-14T00:00:00.000Z"), "2026-08-15T00:00:00.000Z");

  const weekly = schedule("2026-08-14T09:00:00", "Asia/Tokyo", "FREQ=WEEKLY");
  assert.equal(codexScheduleOccurrenceAfter(weekly, "2026-08-14T00:00:00.000Z"), "2026-08-21T00:00:00.000Z");
});

test("monthly skips missing month days instead of rounding", () => {
  for (const day of [29, 30, 31]) {
    const input = schedule(`2026-01-${day}T10:15:00`, "UTC", "FREQ=MONTHLY");
    assert.equal(codexScheduleOccurrenceAfter(input, `2026-01-${day}T10:15:00.000Z`), `2026-03-${day}T10:15:00.000Z`);
  }
});

test("yearly February 29 skips non-leap years", () => {
  const input = schedule("2024-02-29T08:00:00", "UTC", "FREQ=YEARLY");
  assert.equal(codexScheduleOccurrenceAfter(input, "2024-02-29T08:00:00.000Z"), "2028-02-29T08:00:00.000Z");
});

test("spring-forward gaps are skipped", () => {
  const input = schedule("2026-03-07T02:30:00", "America/New_York", "FREQ=DAILY");
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-03-07T07:30:00.000Z"), "2026-03-09T06:30:00.000Z");
});

test("fall-back duplicates choose the earlier instant once", () => {
  const input = schedule("2026-10-31T01:30:00", "America/New_York", "FREQ=DAILY");
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-10-31T05:30:00.000Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(codexScheduleOccurrenceAfter(input, "2026-11-01T05:30:00.000Z"), "2026-11-02T06:30:00.000Z");
  assert.equal(codexScheduleOccurrenceAtOrBefore(input, "2026-11-01T06:00:00.000Z"), "2026-11-01T05:30:00.000Z");
});

test("rejects invalid timezone, local dates, seconds, and RRULEs", () => {
  assert.throws(() => codexScheduleOccurrenceAfter(schedule("2026-01-01T09:00:00", "Not/AZone"), new Date()), /timeZone/);
  assert.throws(() => codexScheduleOccurrenceAfter(schedule("2026-02-30T09:00:00"), new Date()), /real local/);
  assert.throws(() => codexScheduleOccurrenceAfter(schedule("2026-01-01T09:00:01"), new Date()), /startLocal/);
  assert.throws(() => codexScheduleOccurrenceAfter(schedule(" 2026-01-01T09:00:00"), new Date()), /startLocal/);
  assert.throws(() => codexScheduleOccurrenceAfter(schedule("2026-01-01T09:00:00 "), new Date()), /startLocal/);
  assert.throws(() => codexScheduleOccurrenceAfter(schedule("2026-01-01T09:00:00", "UTC", "FREQ=HOURLY"), new Date()), /rrule/);
});
