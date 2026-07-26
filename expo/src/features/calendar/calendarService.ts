import * as Calendar from "expo-calendar";
import {
  calendarError,
  type CalendarCreateInput,
  type CalendarCreateResult,
  type CalendarDeleteInput,
  type CalendarDeleteResult,
  type CalendarEventDetail,
  type CalendarEventSummary,
  type CalendarGetResult,
  type CalendarListResult,
  type CalendarSearchResult,
  type CalendarToolResult,
  type CalendarUpdateInput,
  type CalendarUpdateResult,
} from "./calendarToolSpecs";

const MAX_SEARCH_DAYS = 31;
const MAX_SEARCH_EVENTS = 100;
const MAX_SEARCH_BYTES = 128 * 1024;

function objectWithOnly(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => fields.includes(key));
}

function truncate(value: unknown, maximum: number) {
  return String(value ?? "").slice(0, maximum);
}

function dateOf(value: string | Date | undefined) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function isRecurring(event: Calendar.Event) {
  return event.recurrenceRule != null || event.originalStartDate != null || event.isDetached === true;
}

function localDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(year, month - 1, day, 0, 0, 0, 0);
  return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === day ? result : null;
}

function localDateString(value: string | Date) {
  const date = dateOf(value);
  if (!date) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function offsetMinutes(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const wallClock = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return Math.round((wallClock - instant.getTime()) / 60_000);
}

function parseTimedDate(value: unknown, timeZone?: unknown) {
  const text = String(value || "");
  const zone = String(timeZone || "").trim();
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text) || !zone) return null;
  const date = dateOf(text);
  if (!date) return null;
  try {
    const supplied = text.endsWith("Z") ? 0 : (() => {
      const match = /([+-])(\d{2}):(\d{2})$/.exec(text);
      return match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : Number.NaN;
    })();
    return supplied === offsetMinutes(date, zone) ? date : null;
  } catch {
    return null;
  }
}

function parseAlarmInput(value: unknown): Calendar.Alarm[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) return null;
  const alarms: Calendar.Alarm[] = [];
  for (const item of value) {
    const minutes = Number((item as Record<string, unknown>)?.minutesBefore);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > 40_320) return null;
    alarms.push({ relativeOffset: -minutes });
  }
  return alarms;
}

function eventDateValue(event: Calendar.Event, field: "startDate" | "endDate") {
  return event.allDay ? localDateString(event[field]) : dateOf(event[field])?.toISOString() || "";
}

function lastModifiedAt(event: Calendar.Event) {
  return dateOf(event.lastModifiedDate)?.toISOString() ?? null;
}

function calendarById(calendars: Calendar.Calendar[], id: string) {
  return calendars.find((calendar) => calendar.id === id) ?? null;
}

export async function getCalendarPermission(): Promise<CalendarToolResult<null>> {
  try {
    const current = await Calendar.getCalendarPermissionsAsync();
    if (current.granted) return { ok: true, data: null };
    if (current.status === "undetermined") return calendarError("calendar_permission_undetermined");
    return calendarError("calendar_permission_denied");
  } catch {
    return calendarError("calendar_permission_denied");
  }
}

// This is deliberately the only API that can invoke the OS permission prompt.
// Tool calls and headless notification work use getCalendarPermission() above.
export async function requestCalendarPermission(): Promise<CalendarToolResult<null>> {
  try {
    const current = await Calendar.getCalendarPermissionsAsync();
    if (current.granted) return { ok: true, data: null };
    const requested = await Calendar.requestCalendarPermissionsAsync();
    return requested.granted ? { ok: true, data: null } : calendarError("calendar_permission_denied");
  } catch {
    return calendarError("calendar_permission_denied");
  }
}

async function eventCalendars() {
  return Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
}

function summarizeEvent(event: Calendar.Event, calendars: Calendar.Calendar[]): CalendarEventSummary | null {
  const calendar = calendarById(calendars, event.calendarId);
  const start = eventDateValue(event, "startDate");
  const end = eventDateValue(event, "endDate");
  if (!calendar || !start || !end) return null;
  const recurring = isRecurring(event);
  return {
    id: event.id,
    instanceStart: recurring ? start : null,
    calendarId: event.calendarId,
    calendarTitle: truncate(calendar.title, 500),
    title: truncate(event.title, 500),
    start,
    end,
    allDay: event.allDay === true,
    timeZone: event.allDay ? null : String(event.timeZone || "").trim() || null,
    recurring,
    detached: event.isDetached === true,
    allowsModifications: calendar.allowsModifications === true,
    lastModifiedAt: lastModifiedAt(event),
  };
}

export async function listCalendars(): Promise<CalendarToolResult<CalendarListResult>> {
  try {
    const [calendars, defaultCalendar] = await Promise.all([eventCalendars(), Calendar.getDefaultCalendarAsync().catch(() => null)]);
    return {
      ok: true,
      data: {
        calendars: calendars.map((calendar) => ({
          id: calendar.id,
          title: truncate(calendar.title, 500),
          sourceName: truncate(calendar.source?.name, 200),
          allowsModifications: calendar.allowsModifications === true,
          isDefault: calendar.id === defaultCalendar?.id,
        })),
      },
    };
  } catch {
    return calendarError("calendar_api_failed", true);
  }
}

export async function searchEvents(input: unknown): Promise<CalendarToolResult<CalendarSearchResult>> {
  if (!objectWithOnly(input, ["start", "end", "calendarIds"])) return calendarError("invalid_arguments");
  const value = input;
  if (typeof value.start !== "string" || typeof value.end !== "string") return calendarError("invalid_arguments");
  const startText = value.start;
  const endText = value.end;
  const rawStart = /(Z|[+-]\d{2}:\d{2})$/.test(startText) ? dateOf(startText) : null;
  const rawEnd = /(Z|[+-]\d{2}:\d{2})$/.test(endText) ? dateOf(endText) : null;
  if (!rawStart || !rawEnd) return calendarError("invalid_arguments");
  const from = rawStart!;
  const to = rawEnd!;
  if (to <= from || to.getTime() - from.getTime() > MAX_SEARCH_DAYS * 86_400_000) return calendarError("invalid_date_range");
  const requestedIds = value?.calendarIds;
  if (requestedIds !== undefined && (!Array.isArray(requestedIds) || requestedIds.length > 20 || requestedIds.some((id) => typeof id !== "string" || !id.trim()))) {
    return calendarError("invalid_arguments");
  }
  try {
    const calendars = await eventCalendars();
    const ids = requestedIds === undefined ? calendars.map((calendar) => calendar.id) : requestedIds.map((id) => String(id));
    if (ids.some((id) => !calendarById(calendars, id))) return calendarError("calendar_not_found");
    if (ids.length === 0) return { ok: true, data: { events: [], truncated: false } };
    const events = await Calendar.getEventsAsync(ids, from, to);
    const selected: CalendarEventSummary[] = [];
    let truncated = false;
    for (const event of events.sort((left, right) => dateOf(left.startDate)!.getTime() - dateOf(right.startDate)!.getTime())) {
      const eventStart = dateOf(event.startDate);
      const eventEnd = dateOf(event.endDate);
      if (!eventStart || !eventEnd || eventStart >= to || eventEnd <= from) continue;
      const summary = summarizeEvent(event, calendars);
      if (!summary) continue;
      const candidate = [...selected, summary];
      // Reserve the final `truncated: true` byte budget while selecting, otherwise
      // a result that just fits as false can exceed the limit after truncation.
      if (candidate.length > MAX_SEARCH_EVENTS || new TextEncoder().encode(JSON.stringify({ events: candidate, truncated: true })).length > MAX_SEARCH_BYTES) {
        truncated = true;
        break;
      }
      selected.push(summary);
    }
    return { ok: true, data: { events: selected, truncated } };
  } catch {
    return calendarError("calendar_api_failed", true);
  }
}

async function findEvent(eventId: string, instanceStart?: string, detached?: boolean) {
  const calendars = await eventCalendars();
  if (!instanceStart) {
    const event = await Calendar.getEventAsync(eventId);
    return { event, calendars };
  }
  const instance = dateOf(instanceStart);
  if (!instance) return null;
  const windowStart = new Date(instance.getTime() - 36 * 60 * 60 * 1000);
  const windowEnd = new Date(instance.getTime() + 36 * 60 * 60 * 1000);
  const candidates = await Calendar.getEventsAsync(calendars.map((calendar) => calendar.id), windowStart, windowEnd);
  const event = candidates.find((candidate) => candidate.id === eventId
    && dateOf(candidate.startDate)?.getTime() === instance.getTime()
    && candidate.isDetached === detached);
  return event ? { event, calendars } : null;
}

export async function getEvent(input: unknown): Promise<CalendarToolResult<CalendarGetResult>> {
  if (!objectWithOnly(input, ["eventId", "instanceStart", "detached"])) return calendarError("invalid_arguments");
  const value = input;
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const instanceStart = value.instanceStart === undefined ? undefined : (typeof value.instanceStart === "string" ? value.instanceStart : null);
  const detached = value.detached === undefined ? undefined : value.detached === true;
  if (!eventId || instanceStart === null || (value.detached !== undefined && typeof value.detached !== "boolean")) return calendarError("invalid_arguments");
  try {
    const found = await findEvent(eventId, instanceStart, detached);
    if (!found) return calendarError("event_not_found");
    if (!instanceStart && isRecurring(found.event)) return calendarError("invalid_arguments");
    const summary = summarizeEvent(found.event, found.calendars);
    if (!summary) return calendarError("event_not_found");
    const detail: CalendarEventDetail = {
      ...summary,
      location: found.event.location == null ? null : truncate(found.event.location, 1000),
      notes: found.event.notes == null ? null : truncate(found.event.notes, 8000),
    };
    return { ok: true, data: { event: detail } };
  } catch {
    return calendarError("event_not_found");
  }
}

function parseCreateInput(input: unknown): CalendarCreateInput | null {
  if (!objectWithOnly(input, ["calendarId", "title", "start", "end", "allDay", "timeZone", "location", "notes", "alarms"])) return null;
  const value = input;
  if (typeof value.title !== "string" || typeof value.start !== "string" || typeof value.end !== "string" || typeof value.allDay !== "boolean") return null;
  const calendarId = value.calendarId === undefined ? undefined : (typeof value.calendarId === "string" ? value.calendarId.trim() : "");
  const title = value.title.trim();
  const start = value.start;
  const end = value.end;
  const timeZone = value.timeZone === undefined ? undefined : (typeof value.timeZone === "string" ? value.timeZone.trim() : "");
  const alarms = value.alarms as CalendarCreateInput["alarms"];
  if (!title || title.length > 10_000 || !start || !end || (calendarId !== undefined && !calendarId)) return null;
  if (value.location !== undefined && typeof value.location !== "string") return null;
  if (value.notes !== undefined && typeof value.notes !== "string") return null;
  return { calendarId, title, start, end, allDay: value.allDay, timeZone, location: value.location as string | undefined, notes: value.notes as string | undefined, alarms };
}

function eventFields(input: CalendarCreateInput) {
  const alarms = parseAlarmInput(input.alarms);
  if (!alarms) return null;
  if (input.allDay) {
    if (input.timeZone !== undefined || !localDate(input.start) || !localDate(input.end) || input.end <= input.start) return null;
    return { startDate: localDate(input.start)!, endDate: localDate(input.end)!, allDay: true, alarms };
  }
  const start = parseTimedDate(input.start, input.timeZone);
  const end = parseTimedDate(input.end, input.timeZone);
  if (!start || !end || end <= start) return null;
  return { startDate: start, endDate: end, allDay: false, timeZone: input.timeZone, alarms };
}

async function writeCalendar(calendarId: string | undefined) {
  const calendars = await eventCalendars();
  const calendar = calendarId ? calendarById(calendars, calendarId) : await Calendar.getDefaultCalendarAsync();
  if (!calendar) return { error: calendarError<never>("calendar_not_found") };
  if (!calendar.allowsModifications) return { error: calendarError<never>("calendar_read_only") };
  return { calendar };
}

export async function prepareCalendarWrite(tool: "calendar_create_event" | "calendar_update_event" | "calendar_delete_event", input: unknown): Promise<CalendarToolResult<{
  title: string; start: string; end: string; allDay: boolean; timeZone: string | null;
  location: string | null; notes: string | null; calendarId: string; lastModifiedAt: string | null;
  recurring: boolean; allowsModifications: boolean;
}>> {
  if (tool === "calendar_create_event") {
    const parsed = parseCreateInput(input);
    const fields = parsed && eventFields(parsed);
    if (!parsed || !fields) return calendarError("invalid_arguments");
    try {
      const target = await writeCalendar(parsed.calendarId);
      if ("error" in target) return target.error ?? calendarError("calendar_api_failed");
      return {
        ok: true,
        data: {
          title: parsed.title, start: fields.startDate.toISOString(), end: fields.endDate.toISOString(), allDay: parsed.allDay,
          timeZone: parsed.allDay ? null : parsed.timeZone ?? null, location: parsed.location ?? null, notes: parsed.notes ?? null,
          calendarId: target.calendar.id, lastModifiedAt: null, recurring: false, allowsModifications: target.calendar.allowsModifications === true,
        },
      };
    } catch { return calendarError("calendar_api_failed", true); }
  }
  const value = input as Record<string, unknown>;
  const eventId = typeof value?.eventId === "string" ? value.eventId.trim() : "";
  const expected = value?.expectedLastModifiedAt;
  if (!eventId || (expected !== null && typeof expected !== "string")) return calendarError("invalid_arguments");
  try {
    const found = await findEvent(eventId);
    if (!found) return calendarError("event_not_found");
    const summary = summarizeEvent(found.event, found.calendars);
    if (!summary) return calendarError("event_not_found");
    if (summary.recurring) return calendarError("recurring_event_write_unsupported");
    if (!summary.lastModifiedAt) return calendarError("event_version_unavailable");
    if (expected !== summary.lastModifiedAt) return calendarError("event_changed");
    if (!summary.allowsModifications) return calendarError("calendar_read_only");
    return { ok: true, data: {
      title: summary.title, start: summary.start, end: summary.end, allDay: summary.allDay, timeZone: summary.timeZone,
      location: found.event.location == null ? null : truncate(found.event.location, 1000),
      notes: found.event.notes == null ? null : truncate(found.event.notes, 8000), calendarId: summary.calendarId,
      lastModifiedAt: summary.lastModifiedAt, recurring: summary.recurring, allowsModifications: summary.allowsModifications,
    } };
  } catch { return calendarError("calendar_api_failed", true); }
}

export async function createEvent(input: unknown): Promise<CalendarToolResult<CalendarCreateResult>> {
  const parsed = parseCreateInput(input);
  const fields = parsed && eventFields(parsed);
  if (!parsed || !fields) return calendarError("invalid_arguments");
  try {
    const target = await writeCalendar(parsed.calendarId);
    if ("error" in target) return target.error ?? calendarError("calendar_api_failed");
    const eventId = await Calendar.createEventAsync(target.calendar.id, {
      ...fields, title: parsed.title, location: parsed.location, notes: parsed.notes,
    });
    const created = await Calendar.getEventAsync(eventId).catch(() => null);
    return { ok: true, data: { eventId, lastModifiedAt: created ? lastModifiedAt(created) : null } };
  } catch {
    return calendarError("calendar_api_failed", true);
  }
}

export async function updateEvent(input: unknown): Promise<CalendarToolResult<CalendarUpdateResult>> {
  if (!objectWithOnly(input, ["eventId", "expectedLastModifiedAt", "changes"])) return calendarError("invalid_arguments");
  const value = input as CalendarUpdateInput;
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const expected = value?.expectedLastModifiedAt;
  const changes = value?.changes;
  if (!eventId || (expected !== null && typeof expected !== "string") || !objectWithOnly(changes, ["calendarId", "title", "start", "end", "allDay", "timeZone", "location", "notes", "alarms"]) || Object.keys(changes).length === 0) return calendarError("invalid_arguments");
  if ((changes.calendarId !== undefined && typeof changes.calendarId !== "string")
    || (changes.title !== undefined && typeof changes.title !== "string")
    || (changes.start !== undefined && typeof changes.start !== "string")
    || (changes.end !== undefined && typeof changes.end !== "string")
    || (changes.allDay !== undefined && typeof changes.allDay !== "boolean")
    || (changes.timeZone !== undefined && typeof changes.timeZone !== "string")
    || (changes.location !== undefined && changes.location !== null && typeof changes.location !== "string")
    || (changes.notes !== undefined && changes.notes !== null && typeof changes.notes !== "string")) return calendarError("invalid_arguments");
  try {
    const found = await findEvent(eventId);
    if (!found) return calendarError("event_not_found");
    if (isRecurring(found.event)) return calendarError("recurring_event_write_unsupported");
    const actual = lastModifiedAt(found.event);
    if (!expected || !actual) return calendarError("event_version_unavailable");
    if (expected !== actual) return calendarError("event_changed");
    const nextAllDay = changes.allDay ?? found.event.allDay;
    if (changes.allDay !== undefined && (changes.start === undefined || changes.end === undefined)) return calendarError("invalid_arguments");
    const merged: CalendarCreateInput = {
      calendarId: changes.calendarId ?? found.event.calendarId,
      title: changes.title ?? found.event.title,
      start: changes.start ?? eventDateValue(found.event, "startDate"),
      end: changes.end ?? eventDateValue(found.event, "endDate"),
      allDay: nextAllDay,
      timeZone: changes.timeZone ?? (nextAllDay ? undefined : found.event.timeZone),
      location: changes.location === undefined ? found.event.location ?? undefined : changes.location ?? undefined,
      notes: changes.notes === undefined ? found.event.notes ?? undefined : changes.notes ?? undefined,
      alarms: changes.alarms === undefined ? found.event.alarms.map((alarm) => ({ minutesBefore: Math.max(0, -Number(alarm.relativeOffset || 0)) })) : changes.alarms,
    };
    const fields = eventFields(merged);
    if (!fields) return calendarError("invalid_arguments");
    const target = await writeCalendar(merged.calendarId);
    if ("error" in target) return target.error ?? calendarError("calendar_api_failed");
    const updatedId = await Calendar.updateEventAsync(eventId, { ...fields, calendarId: target.calendar.id, title: merged.title, location: merged.location ?? undefined, notes: merged.notes ?? undefined });
    const updated = await Calendar.getEventAsync(updatedId).catch(() => null);
    return { ok: true, data: { eventId: updatedId, lastModifiedAt: updated ? lastModifiedAt(updated) : null } };
  } catch {
    return calendarError("calendar_api_failed", true);
  }
}

export async function deleteEvent(input: unknown): Promise<CalendarToolResult<CalendarDeleteResult>> {
  if (!objectWithOnly(input, ["eventId", "expectedLastModifiedAt"])) return calendarError("invalid_arguments");
  const value = input as CalendarDeleteInput;
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  if (!eventId || (value?.expectedLastModifiedAt !== null && typeof value?.expectedLastModifiedAt !== "string")) return calendarError("invalid_arguments");
  try {
    const found = await findEvent(eventId);
    if (!found) return calendarError("event_not_found");
    if (isRecurring(found.event)) return calendarError("recurring_event_write_unsupported");
    const actual = lastModifiedAt(found.event);
    if (!value.expectedLastModifiedAt || !actual) return calendarError("event_version_unavailable");
    if (value.expectedLastModifiedAt !== actual) return calendarError("event_changed");
    const calendar = calendarById(found.calendars, found.event.calendarId);
    if (!calendar?.allowsModifications) return calendarError("calendar_read_only");
    await Calendar.deleteEventAsync(eventId);
    return { ok: true, data: { deletedEventId: eventId } };
  } catch {
    return calendarError("calendar_api_failed", true);
  }
}
