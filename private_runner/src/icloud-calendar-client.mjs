import { randomUUID } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import ICAL from "ical.js";
import { ICLOUD_MESSAGES, iCloudError } from "./icloud-calendar-service.mjs";

const DAV = "DAV:", CAL = "urn:ietf:params:xml:ns:caldav";
const START = "https://caldav.icloud.com/";
const MAX_BYTES = 8 * 1024 * 1024;
const children = (node, namespace, local) => Array.from(node?.childNodes || [])
  .filter((child) => child.nodeType === 1 && child.namespaceURI === namespace && child.localName === local);
const child = (node, namespace, local) => children(node, namespace, local)[0];
const text = (node, namespace, local) => child(node, namespace, local)?.textContent || "";
const timestamp = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");
const id = (kind, value) => `icloud:${kind}:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

export function iCloudUrl(base, href) {
  try {
    if (typeof href !== "string" || !href || /[\s\x00-\x1f\x7f]/u.test(href)) throw new Error();
    const url = new URL(href, base);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || !/^(?:[a-z0-9-]+\.)*icloud\.com$/i.test(url.hostname) || /\/\/@/.test(href)) throw new Error();
    return url.href;
  } catch { throw iCloudError("icloud_response_invalid", 502); }
}

function properties(response) {
  const result = [];
  for (const propstat of children(response, DAV, "propstat")) {
    if (/^HTTP\/\S+ 200(?: |$)/.test(text(propstat, DAV, "status"))) {
      result.push(...Array.from(child(propstat, DAV, "prop")?.childNodes || []).filter((node) => node.nodeType === 1));
    }
  }
  return { childNodes: result };
}

function decodeId(value, kind) {
  try {
    if (typeof value !== "string" || value.length > 8192 || !value.startsWith(`icloud:${kind}:`)) throw new Error();
    return JSON.parse(Buffer.from(value.slice(`icloud:${kind}:`.length), "base64url").toString("utf8"));
  } catch { throw iCloudError("invalid_arguments"); }
}

function dateRange(input) {
  const values = [input?.start, input?.end];
  if (!values.every((value) => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value))) throw iCloudError("invalid_arguments");
  const [start, end] = values.map((value) => new Date(value));
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 31 * 86400000) throw iCloudError("invalid_date_range");
  return { start, end };
}

// ICAL.js reads escaping/folding, duration, DATE values and embedded VTIMEZONE.
// iCloud expands RRULE/RDATE/EXDATE; this client never iterates historical rules.
function calendarDocument(data, calendar) {
  try {
    const root = new ICAL.Component(ICAL.parse(data));
    if (root.name !== "vcalendar") throw new Error();
    if (calendar.timezone) {
      const zoneRoot = new ICAL.Component(ICAL.parse(calendar.timezone));
      for (const zone of zoneRoot.getAllSubcomponents("vtimezone")) {
        if (!root.getTimeZoneByID(zone.getFirstPropertyValue("tzid"))) root.addSubcomponent(zone);
      }
    }
    for (const event of root.getAllSubcomponents("vevent")) {
      for (const name of ["dtstart", "dtend", "recurrence-id"]) {
        const tzid = event.getFirstProperty(name)?.getParameter("tzid");
        if (tzid && tzid !== "UTC" && !root.getTimeZoneByID(tzid)) throw new Error();
      }
    }
    return root;
  } catch { throw iCloudError("icloud_response_invalid", 502); }
}

function eventTime(value, component, calendar) {
  if (!value) throw iCloudError("icloud_response_invalid", 502);
  if (value.isDate) return value.toString();
  const result = value.clone();
  if (result.zone.tzid === "floating") {
    const tzid = component.getFirstProperty("dtstart")?.getParameter("tzid") || calendar.timeZone;
    const zone = tzid && component.parent.getTimeZoneByID(tzid);
    if (!zone) throw iCloudError("icloud_response_invalid", 502);
    result.zone = zone;
  }
  const date = new Date(result.toUnixTime() * 1000);
  if (!Number.isFinite(+date)) throw iCloudError("icloud_response_invalid", 502);
  return date.toISOString();
}

function sortInstant(value, calendar) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return +new Date(value);
  const time = ICAL.Time.fromDateString(value);
  time.isDate = false;
  const zone = calendar.timezone && new ICAL.Component(ICAL.parse(calendar.timezone)).getTimeZoneByID(calendar.timeZone);
  if (!zone) throw iCloudError("icloud_response_invalid", 502);
  time.zone = zone;
  return time.toUnixTime() * 1000;
}

export function createICloudCalendarClient({ account, password, fetchImpl = fetch }) {
  const authorization = `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`;
  let discovered;
  const deadline = (signal) => AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  const request = async (target, method, body, depth, signal, headers = {}) => {
    const mutation = method === "PUT" || method === "DELETE";
    let sent = false;
    let url = iCloudUrl(START, target);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal?.throwIfAborted();
        sent = true;
        const response = await fetchImpl(url, { method, body, redirect: "manual", signal,
          headers: { Authorization: authorization, "Content-Type": mutation ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8", ...(depth === undefined ? {} : { Depth: String(depth) }), ...headers } });
        if (!mutation && [301, 302, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw iCloudError("icloud_response_invalid", 502);
          url = iCloudUrl(url, location); continue;
        }
        if (response.status !== 207) await response.body?.cancel();
        if (response.status === 401) throw iCloudError("icloud_authentication_failed", 401);
        if (response.status === 403) throw iCloudError("icloud_access_denied", 403);
        if (mutation) {
          if (response.status === 412) throw iCloudError("event_changed", 409);
          if (response.status === 404) throw iCloudError("event_not_found", 404);
          if (![200, 201, 204].includes(response.status)) throw iCloudError(response.status >= 500 ? "result_unknown" : "icloud_response_invalid", 502);
          return { url };
        }
        if (response.status !== 207 || !response.body) throw iCloudError("icloud_response_invalid", 502);
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > MAX_BYTES) throw iCloudError("icloud_response_too_large", 502);
            chunks.push(Buffer.from(part.value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const xml = Buffer.concat(chunks).toString("utf8");
        if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw iCloudError("icloud_response_invalid", 502);
        let document;
        try { document = new DOMParser({ onError: () => { throw new Error(); } }).parseFromString(xml, "application/xml"); }
        catch { throw iCloudError("icloud_response_invalid", 502); }
        if (document.documentElement?.namespaceURI !== DAV || document.documentElement?.localName !== "multistatus") throw iCloudError("icloud_response_invalid", 502);
        return { url, responses: children(document.documentElement, DAV, "response") };
      }
      throw iCloudError("icloud_response_invalid", 502);
    } catch (error) {
      if (error?.code && Object.hasOwn(ICLOUD_MESSAGES, error.code)) throw error;
      if (mutation && sent) throw iCloudError("result_unknown", 502);
      if (signal?.aborted) throw iCloudError("request_cancelled", 408);
      throw iCloudError("icloud_connection_failed", 502);
    }
  };
  const discoverHref = async (url, namespace, name, signal) => {
    const prefix = namespace === DAV ? "d" : "c";
    const result = await request(url, "PROPFIND", `<d:propfind xmlns:d="${DAV}" xmlns:c="${CAL}"><d:prop><${prefix}:${name}/></d:prop></d:propfind>`, 0, signal);
    for (const response of result.responses) {
      const href = text(child(properties(response), namespace, name), DAV, "href");
      if (href) return iCloudUrl(result.url, href);
    }
    throw iCloudError("icloud_response_invalid", 502);
  };
  const calendars = async (signal) => {
    if (!discovered) discovered = (async () => {
      const principal = await discoverHref(START, DAV, "current-user-principal", signal);
      const home = await discoverHref(principal, CAL, "calendar-home-set", signal);
      const result = await request(home, "PROPFIND", `<d:propfind xmlns:d="${DAV}" xmlns:c="${CAL}"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><c:calendar-timezone/><d:current-user-privilege-set/></d:prop></d:propfind>`, 1, signal);
      const values = [];
      for (const response of result.responses) {
        const prop = properties(response);
        if (!child(child(prop, DAV, "resourcetype"), CAL, "calendar")
          || !children(child(prop, CAL, "supported-calendar-component-set"), CAL, "comp").some((comp) => comp.getAttribute("name") === "VEVENT")) continue;
        const url = iCloudUrl(result.url, text(response, DAV, "href"));
        const timezone = text(prop, CAL, "calendar-timezone");
        let timeZone = "";
        if (timezone) {
          try { timeZone = new ICAL.Component(ICAL.parse(timezone)).getFirstSubcomponent("vtimezone")?.getFirstPropertyValue("tzid") || ""; }
          catch { throw iCloudError("icloud_response_invalid", 502); }
        }
        const privileges = children(child(prop, DAV, "current-user-privilege-set"), DAV, "privilege");
        const allowsModifications = ["write-content", "bind", "unbind"].every((name) => privileges.some((value) => child(value, DAV, name) || child(value, DAV, "write") || child(value, DAV, "all")));
        values.push({ id: id("calendar", url), url, allowsModifications, title: text(prop, DAV, "displayname").slice(0, 500), timezone, timeZone });
      }
      return values;
    })();
    return discovered;
  };
  const resources = (result, calendar) => result.responses.map((response) => {
    const prop = properties(response), href = text(response, DAV, "href"), data = text(prop, CAL, "calendar-data");
    if (!data) throw iCloudError("icloud_response_invalid", 502);
    const url = iCloudUrl(result.url, href);
    const base = new URL(calendar.url), target = new URL(url);
    if (base.origin !== target.origin || !target.pathname.startsWith(base.pathname.endsWith("/") ? base.pathname : base.pathname + "/")) throw iCloudError("icloud_response_invalid", 502);
    return { url, etag: text(prop, DAV, "getetag"), document: calendarDocument(data, calendar) };
  });
  const multiget = async (calendar, urls, signal) => {
    const hrefs = urls.map((url) => `<d:href>${new URL(iCloudUrl(calendar.url, url)).pathname.replaceAll("&", "&amp;")}</d:href>`).join("");
    return resources(await request(calendar.url, "REPORT", `<c:calendar-multiget xmlns:d="${DAV}" xmlns:c="${CAL}"><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs}</c:calendar-multiget>`, 1, signal), calendar);
  };
  const query = async (calendar, range, signal) => resources(await request(calendar.url, "REPORT", `<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CAL}"><d:prop><c:calendar-data><c:expand start="${timestamp(range.start)}" end="${timestamp(range.end)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${timestamp(range.start)}" end="${timestamp(range.end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, 1, signal), calendar);
  const summaries = (expanded, raw, calendar) => {
    const original = raw.document.getAllSubcomponents("vevent");
    const values = [];
    for (const component of expanded.document.getAllSubcomponents("vevent")) {
      if (component.hasProperty("rrule") || component.hasProperty("rdate")) throw iCloudError("icloud_response_invalid", 502);
      const event = new ICAL.Event(component);
      if (component.getFirstPropertyValue("status") === "CANCELLED") continue;
      const sameUid = original.filter((item) => item.getFirstPropertyValue("uid") === event.uid);
      if (!event.uid || !sameUid.length) throw iCloudError("icloud_response_invalid", 502);
      const recurrence = component.getFirstPropertyValue("recurrence-id");
      const exception = recurrence && sameUid.find((item) => {
        const value = item.getFirstPropertyValue("recurrence-id");
        return value && eventTime(value, item, calendar) === eventTime(recurrence, component, calendar);
      });
      const source = exception || sameUid.find((item) => !item.hasProperty("recurrence-id")) || sameUid[0];
      const recurring = Boolean(recurrence || source.hasProperty("rrule") || source.hasProperty("rdate"));
      const start = eventTime(event.startDate, component, calendar), end = eventTime(event.endDate, component, calendar);
      const modified = source.getFirstPropertyValue("last-modified");
      values.push({ id: id("event", { calendar: calendar.url, resource: raw.url, uid: event.uid }),
        instanceStart: recurring ? start : null, calendarId: calendar.id, calendarTitle: calendar.title,
        title: String(component.getFirstPropertyValue("summary") || "").slice(0, 500), start, end,
        allDay: event.startDate.isDate, timeZone: event.startDate.isDate ? null : source.getFirstProperty("dtstart")?.getParameter("tzid") || (source.getFirstPropertyValue("dtstart")?.zone.tzid === "UTC" ? "UTC" : calendar.timeZone || null),
        recurring, detached: Boolean(exception), allowsModifications: calendar.allowsModifications,
        lastModifiedAt: modified ? eventTime(modified, source, calendar) : null,
        location: String(component.getFirstPropertyValue("location") || "").slice(0, 1000) || null,
        notes: String(component.getFirstPropertyValue("description") || "").slice(0, 8000) || null });
    }
    return values;
  };
  const findResource = async (eventId, operation) => {
    const identity = decodeId(eventId, "event");
    const calendar = (await calendars(operation)).find((value) => value.url === identity?.calendar);
    if (!calendar || typeof identity.resource !== "string" || typeof identity.uid !== "string") throw iCloudError("event_not_found");
    const resource = iCloudUrl(calendar.url, identity.resource), base = new URL(calendar.url), target = new URL(resource);
    if (base.origin !== target.origin || !target.pathname.startsWith(base.pathname.endsWith("/") ? base.pathname : base.pathname + "/")) throw iCloudError("invalid_arguments");
    const raw = (await multiget(calendar, [resource], operation)).find((value) => value.url === resource);
    if (!raw) throw iCloudError("event_not_found");
    return { identity, calendar, resource, raw };
  };
  const writableResource = async (input, operation) => {
    if (typeof input.eventId !== "string" || (input.expectedLastModifiedAt !== null && typeof input.expectedLastModifiedAt !== "string")) throw iCloudError("invalid_arguments");
    const found = await findResource(input.eventId, operation);
    const components = found.raw.document.getAllSubcomponents("vevent");
    if (components.some((item) => item.hasProperty("rrule") || item.hasProperty("rdate") || item.hasProperty("recurrence-id"))) throw iCloudError("recurring_event_write_unsupported");
    if (components.length !== 1 || components[0].getFirstPropertyValue("uid") !== found.identity.uid) throw iCloudError("icloud_response_invalid", 502);
    const component = components[0], modified = component.getFirstPropertyValue("last-modified");
    if (!modified || !input.expectedLastModifiedAt || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(found.raw.etag)) throw iCloudError("event_version_unavailable");
    if (eventTime(modified, component, found.calendar) !== input.expectedLastModifiedAt) throw iCloudError("event_changed");
    if (!found.calendar.allowsModifications) throw iCloudError("calendar_read_only");
    return { ...found, component };
  };
  const savedVersion = async (eventId, operation) => {
    try {
      const { raw, calendar, identity } = await findResource(eventId, operation);
      const component = raw.document.getAllSubcomponents("vevent").find((value) => value.getFirstPropertyValue("uid") === identity.uid);
      const value = component?.getFirstPropertyValue("last-modified");
      return value ? eventTime(value, component, calendar) : null;
    } catch { return null; }
  };
  const setFields = (component, input, calendar, creating = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["calendarId", "title", "start", "end", "allDay", "timeZone", "location", "notes", "alarms"].includes(key))) throw iCloudError("invalid_arguments");
    const current = creating ? null : new ICAL.Event(component);
    if (["start", "end", "timeZone"].some((key) => input[key] !== undefined && typeof input[key] !== "string")) throw iCloudError("invalid_arguments");
    if (input.allDay !== undefined && typeof input.allDay !== "boolean") throw iCloudError("invalid_arguments");
    if (!creating && input.allDay !== undefined && (input.start === undefined || input.end === undefined)) throw iCloudError("invalid_arguments");
    const allDay = input.allDay ?? current?.startDate.isDate;
    if (input.title !== undefined && typeof input.title !== "string") throw iCloudError("invalid_arguments");
    const title = input.title ?? (creating ? undefined : String(component.getFirstPropertyValue("summary") || ""));
    if (typeof title !== "string" || (creating && !title.trim()) || title.length > 10000 || typeof allDay !== "boolean") throw iCloudError("invalid_arguments");
    if (input.title !== undefined || creating) component.updatePropertyWithValue("summary", creating ? title.trim() : title);
    for (const [key, property] of [["location", "location"], ["notes", "description"]]) {
      if (input[key] !== undefined) {
        if ((creating || input[key] !== null) && typeof input[key] !== "string") throw iCloudError("invalid_arguments");
        component.removeAllProperties(property);
        if (input[key] !== null) component.addPropertyWithValue(property, input[key]);
      }
    }
    if (creating || ["start", "end", "allDay", "timeZone"].some((key) => input[key] !== undefined)) {
      const zone = input.timeZone ?? (creating || allDay || current.startDate.isDate ? undefined
        : component.getFirstProperty("dtstart")?.getParameter("tzid") || (current.startDate.zone.tzid === "UTC" ? "UTC" : calendar.timeZone));
      const values = [input.start ?? (current && eventTime(current.startDate, component, calendar)), input.end ?? (current && eventTime(current.endDate, component, calendar))];
      const dates = values.map((value, index) => {
        if (typeof value !== "string") throw iCloudError("invalid_arguments");
        if (allDay) {
          if (input.timeZone !== undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+new Date(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw iCloudError("invalid_arguments");
          return ICAL.Time.fromDateString(value);
        }
        const match = /([+-])(\d{2}):(\d{2})$/.exec(value), date = new Date(value);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(+date) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10) || typeof zone !== "string" || !zone) throw iCloudError("invalid_arguments");
        try {
          const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
          const offset = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - +date) / 60000);
          if (input[index === 0 ? "start" : "end"] !== undefined && (match ? (match[1] === "+" ? 1 : -1) * (+match[2] * 60 + +match[3]) : 0) !== offset) throw new Error();
        } catch { throw iCloudError("invalid_arguments"); }
        return ICAL.Time.fromJSDate(date, true);
      });
      if (dates[1].compare(dates[0]) <= 0) throw iCloudError("invalid_arguments");
      component.removeAllProperties("duration");
      for (const [index, name] of ["dtstart", "dtend"].entries()) {
        component.removeAllProperties(name);
        component.addPropertyWithValue(name, dates[index]);
      }
    }
    if (input.alarms !== undefined) {
      if (!Array.isArray(input.alarms) || input.alarms.length > 5 || input.alarms.some((item) => !item || Object.keys(item).some((key) => key !== "minutesBefore") || !Number.isInteger(item.minutesBefore) || item.minutesBefore < 0 || item.minutesBefore > 40320)) throw iCloudError("invalid_arguments");
      component.removeAllSubcomponents("valarm");
      for (const alarm of input.alarms) {
        const value = new ICAL.Component("valarm");
        value.addPropertyWithValue("action", "DISPLAY");
        value.addPropertyWithValue("description", title);
        value.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-alarm.minutesBefore * 60));
        component.addSubcomponent(value);
      }
    }
    const modified = ICAL.Time.fromJSDate(new Date(), true);
    component.updatePropertyWithValue("dtstamp", modified);
    component.updatePropertyWithValue("last-modified", modified);
    component.updatePropertyWithValue("sequence", Number(component.getFirstPropertyValue("sequence") || 0) + 1);
  };
  return {
    async listCalendars(signal) {
      const values = await calendars(deadline(signal));
      return { calendars: values.map((value) => ({ id: value.id, title: value.title, sourceName: "iCloud", allowsModifications: value.allowsModifications, isDefault: value === values.find((item) => item.allowsModifications) })) };
    },
    async searchEvents(input, signal) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["start", "end", "calendarIds"].includes(key))) throw iCloudError("invalid_arguments");
      const range = dateRange(input), operation = deadline(signal);
      const all = await calendars(operation);
      if (input.calendarIds !== undefined && (!Array.isArray(input.calendarIds) || input.calendarIds.length > 20 || input.calendarIds.some((value) => typeof value !== "string" || !all.some((calendar) => calendar.id === value)))) throw iCloudError("calendar_not_found");
      const selected = input.calendarIds === undefined ? all : all.filter((calendar) => input.calendarIds.includes(calendar.id));
      let events = [], truncated = false;
      for (const calendar of selected) {
        const data = await query(calendar, range, operation);
        if (data.length > 100) truncated = true;
        const expanded = data.map((resource) => ({ resource,
          first: Math.min(...resource.document.getAllSubcomponents("vevent")
            .filter((component) => component.getFirstPropertyValue("status") !== "CANCELLED")
            .map((component) => sortInstant(eventTime(new ICAL.Event(component).startDate, component, calendar), calendar))),
        })).sort((a, b) => a.first - b.first).slice(0, 100).map((value) => value.resource);
        if (!expanded.length) continue;
        const raw = await multiget(calendar, expanded.map((item) => item.url), operation);
        for (const item of expanded) {
          const original = raw.find((value) => value.url === item.url);
          if (!original) throw iCloudError("icloud_response_invalid", 502);
          for (const detail of summaries(item, original, calendar)) {
            const { location, notes, ...summary } = detail;
            if (!summary.allDay && (new Date(summary.start) >= range.end || (summary.start === summary.end
              ? new Date(summary.end) < range.start : new Date(summary.end) <= range.start))) continue;
            events.push({ summary, instant: sortInstant(summary.start, calendar) });
          }
        }
      }
      events.sort((a, b) => a.instant - b.instant);
      const result = [];
      for (const { summary: event } of events) {
        if (result.length === 100 || Buffer.byteLength(JSON.stringify({ events: [...result, event], truncated: true })) > 128 * 1024) { truncated = true; break; }
        result.push(event);
      }
      return { events: result, truncated };
    },
    async createEvent(input, signal, requestId = randomUUID()) {
      if (typeof requestId !== "string" || !/^[a-z0-9-]{1,80}$/i.test(requestId)) throw iCloudError("invalid_arguments");
      const operation = deadline(signal), all = await calendars(operation);
      if (input?.calendarId !== undefined && typeof input.calendarId !== "string") throw iCloudError("invalid_arguments");
      const calendar = input?.calendarId === undefined ? all.find((value) => value.allowsModifications) : all.find((value) => value.id === input.calendarId);
      if (!calendar) throw iCloudError("calendar_not_found");
      if (!calendar.allowsModifications) throw iCloudError("calendar_read_only");
      const document = new ICAL.Component("vcalendar"), component = new ICAL.Component("vevent");
      document.addPropertyWithValue("version", "2.0");
      document.addPropertyWithValue("prodid", "-//Bitty//Calendar//EN");
      document.addSubcomponent(component);
      const uid = `bitty-${requestId}`;
      component.addPropertyWithValue("uid", uid);
      setFields(component, input, calendar, true);
      const resource = iCloudUrl(calendar.url.endsWith("/") ? calendar.url : calendar.url + "/", `${uid}.ics`);
      await request(resource, "PUT", document.toString(), undefined, operation, { "If-None-Match": "*" });
      const eventId = id("event", { calendar: calendar.url, resource, uid });
      return { eventId, lastModifiedAt: await savedVersion(eventId, operation) };
    },
    async updateEvent(input, signal) {
      if (!input || Object.keys(input).some((key) => !["eventId", "expectedLastModifiedAt", "changes"].includes(key)) || !input.changes || !Object.keys(input.changes).length) throw iCloudError("invalid_arguments");
      const operation = deadline(signal), found = await writableResource(input, operation);
      if (input.changes.calendarId !== undefined && input.changes.calendarId !== found.calendar.id) throw iCloudError("invalid_arguments");
      setFields(found.component, input.changes, found.calendar);
      await request(found.resource, "PUT", found.raw.document.toString(), undefined, operation, { "If-Match": found.raw.etag });
      return { eventId: input.eventId, lastModifiedAt: await savedVersion(input.eventId, operation) };
    },
    async deleteEvent(input, signal) {
      if (!input || Object.keys(input).some((key) => !["eventId", "expectedLastModifiedAt"].includes(key))) throw iCloudError("invalid_arguments");
      const operation = deadline(signal), found = await writableResource(input, operation);
      await request(found.resource, "DELETE", undefined, undefined, operation, { "If-Match": found.raw.etag });
      return { deletedEventId: input.eventId };
    },
    async getEvent(input, signal) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["eventId", "instanceStart", "detached"].includes(key))
        || (input.detached !== undefined && typeof input.detached !== "boolean")) throw iCloudError("invalid_arguments");
      const operation = deadline(signal);
      const { identity, calendar, resource, raw } = await findResource(input.eventId, operation);
      const components = raw.document.getAllSubcomponents("vevent").filter((item) => item.getFirstPropertyValue("uid") === identity.uid);
      const recurring = components.some((item) => item.hasProperty("rrule") || item.hasProperty("rdate") || item.hasProperty("recurrence-id"));
      let expanded = raw;
      if (recurring) {
        if (typeof input.instanceStart !== "string") throw iCloudError("invalid_arguments");
        const instant = new Date(input.instanceStart);
        if (!Number.isFinite(+instant) || !/^(?:\d{4}-\d{2}-\d{2}|.*(?:Z|[+-]\d\d:\d\d))$/.test(input.instanceStart)) throw iCloudError("invalid_arguments");
        const range = { start: new Date(+instant - 36 * 3600000), end: new Date(+instant + 36 * 3600000) };
        expanded = (await query(calendar, range, operation)).find((value) => value.url === resource);
        if (!expanded) throw iCloudError("event_not_found");
      }
      const event = summaries(expanded, raw, calendar).find((value) => decodeId(value.id, "event").uid === identity.uid
        && (!recurring || (+new Date(value.start) === +new Date(input.instanceStart)))
        && (input.detached === undefined || value.detached === input.detached));
      if (!event) throw iCloudError("event_not_found");
      return { event };
    },
  };
}
