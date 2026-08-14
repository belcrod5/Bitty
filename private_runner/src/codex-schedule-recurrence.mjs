import rrulePackage from "rrule";

const { RRule } = rrulePackage;

export const CODEX_SCHEDULE_RRULES = new Set([
  "FREQ=DAILY",
  "FREQ=WEEKLY",
  "FREQ=MONTHLY",
  "FREQ=YEARLY",
]);

const FREQUENCY_BY_RRULE = new Map([
  ["FREQ=DAILY", RRule.DAILY],
  ["FREQ=WEEKLY", RRule.WEEKLY],
  ["FREQ=MONTHLY", RRule.MONTHLY],
  ["FREQ=YEARLY", RRule.YEARLY],
]);

const formatterByTimeZone = new Map();
const offsetsByTimeZoneAndYear = new Map();

function formatter(timeZone) {
  let value = formatterByTimeZone.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterByTimeZone.set(timeZone, value);
  }
  return value;
}

export function validateCodexScheduleTimeZone(raw) {
  const timeZone = String(raw || "").trim();
  if (!timeZone || timeZone.length > 100) throw new Error("timeZone is invalid");
  try {
    formatter(timeZone).format(new Date(0));
  } catch {
    formatterByTimeZone.delete(timeZone);
    throw new Error("timeZone is invalid");
  }
  return timeZone;
}

export function parseCodexScheduleStartLocal(raw) {
  if (typeof raw !== "string" || raw !== raw.trim()) {
    throw new Error("startLocal must use YYYY-MM-DDTHH:mm:00");
  }
  const value = raw;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00$/.exec(value);
  if (!match) throw new Error("startLocal must use YYYY-MM-DDTHH:mm:00");
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() + 1 !== parts.month ||
    date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour ||
    date.getUTCMinutes() !== parts.minute
  ) {
    throw new Error("startLocal is not a real local date and time");
  }
  return { value, parts };
}

export function normalizeCodexScheduleRrule(raw) {
  if (raw === null) return null;
  if (typeof raw !== "string" || !CODEX_SCHEDULE_RRULES.has(raw)) {
    throw new Error("rrule is invalid");
  }
  return raw;
}

function wallPartsAt(date, timeZone) {
  const entries = formatter(timeZone).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]);
  return Object.fromEntries(entries);
}

function sameWallParts(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === 0;
}

function pseudoDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
}

function pseudoParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: 0,
  };
}

function wallInstants(parts, timeZone) {
  const naiveMs = pseudoDate(parts).getTime();
  const cacheKey = `${timeZone}\0${parts.year}`;
  let offsets = offsetsByTimeZoneAndYear.get(cacheKey);
  if (!offsets) {
    offsets = new Set();
    for (let month = 0; month < 12; month += 1) {
      for (const day of [1, 15]) {
        const sampleMs = Date.UTC(parts.year, month, day, 12);
        const sampleParts = wallPartsAt(new Date(sampleMs), timeZone);
        const sampleWallMs = Date.UTC(
          sampleParts.year,
          sampleParts.month - 1,
          sampleParts.day,
          sampleParts.hour,
          sampleParts.minute,
          sampleParts.second,
        );
        offsets.add(sampleWallMs - sampleMs);
      }
    }
    offsetsByTimeZoneAndYear.set(cacheKey, offsets);
  }
  return [...offsets]
    .map((offset) => new Date(naiveMs - offset))
    .filter((candidate) => sameWallParts(wallPartsAt(candidate, timeZone), parts))
    .sort((left, right) => left.getTime() - right.getTime())
    .filter((candidate, index, all) => index === 0 || candidate.getTime() !== all[index - 1].getTime());
}

function createWallRule(startParts, rrule, referenceParts) {
  const referenceMs = pseudoDate(referenceParts).getTime();
  const lookbackDays = rrule === "FREQ=DAILY" ? 7
    : rrule === "FREQ=WEEKLY" ? 14
      : rrule === "FREQ=MONTHLY" ? 366
        : 9 * 366;
  const nearbyStart = new Date(referenceMs - lookbackDays * 24 * 60 * 60 * 1000);
  const options = {
    freq: FREQUENCY_BY_RRULE.get(rrule),
    dtstart: new Date(Math.max(pseudoDate(startParts).getTime(), nearbyStart.getTime())),
    byhour: startParts.hour,
    byminute: startParts.minute,
    bysecond: 0,
  };
  if (rrule === "FREQ=WEEKLY") options.byweekday = pseudoDate(startParts).getUTCDay() === 0
    ? RRule.SU
    : [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA][pseudoDate(startParts).getUTCDay() - 1];
  if (rrule === "FREQ=MONTHLY" || rrule === "FREQ=YEARLY") options.bymonthday = startParts.day;
  if (rrule === "FREQ=YEARLY") options.bymonth = startParts.month;
  return new RRule(options, true);
}

function normalizeArgs(input) {
  const { value: startLocal, parts } = parseCodexScheduleStartLocal(input?.startLocal);
  const timeZone = validateCodexScheduleTimeZone(input?.timeZone);
  const rrule = normalizeCodexScheduleRrule(input?.rrule);
  return { startLocal, parts, timeZone, rrule };
}

export function codexScheduleOccurrenceAfter(input, afterRaw, inclusive = false) {
  const recurrence = normalizeArgs(input);
  const after = new Date(afterRaw);
  if (!Number.isFinite(after.getTime())) throw new Error("after must be a valid instant");
  if (recurrence.rrule === null) {
    const occurrence = wallInstants(recurrence.parts, recurrence.timeZone)[0] || null;
    if (!occurrence) return null;
    return occurrence.getTime() > after.getTime() || (inclusive && occurrence.getTime() === after.getTime())
      ? occurrence.toISOString()
      : null;
  }

  const localAfter = wallPartsAt(after, recurrence.timeZone);
  const rule = createWallRule(recurrence.parts, recurrence.rrule, localAfter);
  let candidate = rule.after(
    new Date(pseudoDate(localAfter).getTime() - 3 * 24 * 60 * 60 * 1000),
    true,
  );
  for (let attempts = 0; candidate && attempts < 10_000; attempts += 1) {
    const occurrence = wallInstants(pseudoParts(candidate), recurrence.timeZone)[0] || null;
    if (occurrence && (
      occurrence.getTime() > after.getTime() ||
      (inclusive && occurrence.getTime() === after.getTime())
    )) {
      return occurrence.toISOString();
    }
    candidate = rule.after(candidate, false);
  }
  return null;
}

export function codexScheduleOccurrenceAtOrBefore(input, beforeRaw) {
  const recurrence = normalizeArgs(input);
  const before = new Date(beforeRaw);
  if (!Number.isFinite(before.getTime())) throw new Error("before must be a valid instant");
  if (recurrence.rrule === null) {
    const occurrence = wallInstants(recurrence.parts, recurrence.timeZone)[0] || null;
    return occurrence && occurrence.getTime() <= before.getTime() ? occurrence.toISOString() : null;
  }

  const localBefore = wallPartsAt(before, recurrence.timeZone);
  const rule = createWallRule(recurrence.parts, recurrence.rrule, localBefore);
  let candidate = rule.before(
    new Date(pseudoDate(localBefore).getTime() + 3 * 24 * 60 * 60 * 1000),
    true,
  );
  for (let attempts = 0; candidate && attempts < 10_000; attempts += 1) {
    const occurrence = wallInstants(pseudoParts(candidate), recurrence.timeZone)[0] || null;
    if (occurrence && occurrence.getTime() <= before.getTime()) return occurrence.toISOString();
    candidate = rule.before(candidate, false);
  }
  return null;
}
