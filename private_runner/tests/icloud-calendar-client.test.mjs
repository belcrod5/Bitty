import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { createICloudCalendarClient, iCloudUrl } from "../src/icloud-calendar-client.mjs";

const CAL = "urn:ietf:params:xml:ns:caldav";
const calendarUrl = "https://p01-caldav.icloud.com/user/cal/";
const zone = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR";
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const resource = (href, properties, status = "200 OK") => `<x:response><x:href>${xml(href)}</x:href><x:propstat><x:prop>${properties}</x:prop><x:status>HTTP/1.1 ${status}</x:status></x:propstat></x:response>`;
const document = (...items) => `<x:multistatus xmlns:x="DAV:" xmlns:y="${CAL}">${items.join("")}</x:multistatus>`;
const data = (href, ics, etag = '"v1"') => resource(href, `<x:getetag>${xml(etag)}</x:getetag><y:calendar-data>${xml(ics)}</y:calendar-data>`);
const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const event = (uid, start, end, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART${start}\r\nDTEND${end}\r\n${extra}END:VEVENT`;
function fixture(privileges = "<x:privilege><x:write/></x:privilege>") {
  const requests = [];
  const responses = [
    document(resource("/", '<x:current-user-principal><x:href>/user/</x:href></x:current-user-principal>')),
    document(resource("/user/", `<y:calendar-home-set><x:href>https://p01-caldav.icloud.com/user/</x:href></y:calendar-home-set>`)),
    document(resource(calendarUrl, `<x:displayname>Work &amp; Life</x:displayname><x:resourcetype><y:calendar/></x:resourcetype><y:supported-calendar-component-set><y:comp name="VEVENT"/></y:supported-calendar-component-set><y:calendar-timezone>${xml(zone)}</y:calendar-timezone><x:current-user-privilege-set>${privileges}</x:current-user-privilege-set>`),
      resource("https://evil.invalid/", '<x:resourcetype><y:calendar/></x:resourcetype>', "404 Not Found")),
  ];
  const client = createICloudCalendarClient({ account: "test@example.invalid", password: "abcd-efgh-ijkl-mnop", fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    const response = responses.shift();
    assert.notEqual(response, undefined, "unexpected network request");
    if (typeof response === "function") return response(url, options);
    return typeof response === "string" ? new Response(response, { status: 207 }) : response;
  } });
  return { client, requests, responses };
}
const range = { start: "2026-11-14T15:00:00.000Z", end: "2026-11-17T15:00:00.000Z" };

test("namespace-correct discovery and folded/escaped event details use the common tool contract", async () => {
  const f = fixture();
  const item = ics(event("one", ":20261115T010000Z", ":20261115T020000Z", "SUMMARY:Long\\, title\r\n  folded\r\nDESCRIPTION:Line one\\nLine two\\; fine\r\nLOCATION:Room\\, A\r\nLAST-MODIFIED:20261101T000000Z\r\n"));
  f.responses.push(document(data(calendarUrl + "one.ics", item)), document(data(calendarUrl + "one.ics", item)));
  const result = await f.client.searchEvents(range);
  assert.equal(result.events[0].title, "Long, title folded");
  assert.equal(result.events[0].allowsModifications, true);
  assert.equal(result.events[0].calendarTitle, "Work & Life");
  assert.equal(result.events[0].timeZone, "UTC");
  assert.equal(result.events[0].lastModifiedAt, "2026-11-01T00:00:00.000Z");
  assert.ok(!("notes" in result.events[0]));
  f.responses.push(document(data(calendarUrl + "one.ics", item)));
  const detail = await f.client.getEvent({ eventId: result.events[0].id });
  assert.equal(detail.event.notes, "Line one\nLine two; fine");
  assert.equal(detail.event.location, "Room, A");
  assert.deepEqual(f.requests.map((request) => request.method), ["PROPFIND", "PROPFIND", "PROPFIND", "REPORT", "REPORT", "REPORT"]);
  assert.ok(f.requests.every((request) => request.redirect === "manual"));
});

test("server-expanded recurrence retains original timezone and distinguishes real detached overrides", async () => {
  const f = fixture();
  const master = event("repeat", ";TZID=Asia/Tokyo:20200101T090000", ";TZID=Asia/Tokyo:20200101T100000", "RRULE:FREQ=DAILY\r\nEXDATE;TZID=Asia/Tokyo:20261117T090000\r\nSUMMARY:Daily\r\n");
  const exception = event("repeat", ";TZID=Asia/Tokyo:20261116T110000", ";TZID=Asia/Tokyo:20261116T120000", "RECURRENCE-ID;TZID=Asia/Tokyo:20261116T090000\r\nSUMMARY:Moved\r\n");
  const raw = ics(master, exception);
  const expanded = ics(event("repeat", ":20261115T000000Z", ":20261115T010000Z", "RECURRENCE-ID:20261115T000000Z\r\nSUMMARY:Daily\r\n"),
    event("repeat", ":20261116T020000Z", ":20261116T030000Z", "RECURRENCE-ID:20261116T000000Z\r\nSUMMARY:Moved\r\n"));
  f.responses.push(document(data(calendarUrl + "repeat.ics", expanded)), document(data(calendarUrl + "repeat.ics", raw)));
  const result = await f.client.searchEvents(range);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].recurring, true);
  assert.equal(result.events[0].detached, false);
  assert.equal(result.events[1].detached, true);
  assert.equal(result.events[1].timeZone, "Asia/Tokyo");
  assert.ok(f.requests[3].body.includes('<c:expand start="20261114T150000Z" end="20261117T150000Z"/>'));
  f.responses.push(document(data(calendarUrl + "repeat.ics", raw)), document(data(calendarUrl + "repeat.ics", expanded)));
  const detail = await f.client.getEvent({ eventId: result.events[1].id, instanceStart: "2026-11-16T11:00:00+09:00", detached: true });
  assert.equal(detail.event.title, "Moved");
  assert.ok(f.requests[5].body.includes("<c:calendar-multiget"));
  assert.ok(!f.requests[5].body.includes("<c:expand"));
  assert.ok(f.requests[6].body.includes("<c:calendar-query"));
  assert.ok(f.requests[6].body.includes("<c:expand"));
  f.responses.push(document(data(calendarUrl + "repeat.ics", raw)));
  await assert.rejects(f.client.getEvent({ eventId: result.events[1].id }), { code: "invalid_arguments" });
});

test("recurring detail uses the same query expansion as search and selects the requested resource and instance", async () => {
  const requests = [];
  const master = ics(event("repeat", ":20200101T001500Z", ":20200101T011500Z", "RRULE:FREQ=DAILY\r\nSUMMARY:Daily\r\n"));
  const expanded = ics(event("repeat", ":20261117T001500Z", ":20261117T011500Z", "RECURRENCE-ID:20261117T001500Z\r\nSUMMARY:Requested\r\n"),
    event("repeat", ":20261118T001500Z", ":20261118T011500Z", "RECURRENCE-ID:20261118T001500Z\r\nSUMMARY:Next\r\n"));
  const f = fixture();
  const report = (_url, options) => {
    requests.push(options.body);
    // A provider returning the original RRULE for multiget cannot satisfy expansion.
    // Only calendar-query returns the instances that both read operations consume.
    return new Response(options.body.includes("<c:calendar-query")
      ? document(data(calendarUrl + "other.ics", ics(event("other", ":20261117T001500Z", ":20261117T011500Z"))), data(calendarUrl + "repeat.ics", expanded))
      : document(data(calendarUrl + "other.ics", ics(event("other", ":20261117T001500Z", ":20261117T011500Z"))), data(calendarUrl + "repeat.ics", master)), { status: 207 });
  };
  f.responses.push(report, report, report, report);
  const found = await f.client.searchEvents({ start: "2026-11-16T00:00:00Z", end: "2026-11-19T00:00:00Z" });
  const selected = found.events.find((value) => value.title === "Requested");
  const detail = await f.client.getEvent({ eventId: selected.id, instanceStart: "2026-11-17T09:15:00+09:00", detached: false });
  assert.equal(detail.event.title, "Requested");
  assert.equal(detail.event.start, "2026-11-17T00:15:00.000Z");
  assert.equal(detail.event.id, selected.id);
  assert.equal(requests.filter((body) => body.includes("<c:calendar-query")).length, 2);
  assert.ok(requests.filter((body) => body.includes("<c:calendar-multiget")).every((body) => !body.includes("<c:expand")));
});

test("all-day dates remain dates and sort at calendar-local midnight, including timezone range boundaries", async () => {
  const f = fixture();
  const timed = ics(event("timed", ":20261114T220000Z", ":20261114T230000Z", "SUMMARY:7am Tokyo\r\n"));
  const allDay = ics(event("date", ";VALUE=DATE:20261115", ";VALUE=DATE:20261116", "SUMMARY:All day\r\n"));
  f.responses.push(document(data(calendarUrl + "timed.ics", timed), data(calendarUrl + "date.ics", allDay)),
    document(data(calendarUrl + "timed.ics", timed), data(calendarUrl + "date.ics", allDay)));
  const result = await f.client.searchEvents({ start: "2026-11-14T15:00:00Z", end: "2026-11-15T15:00:00Z" });
  assert.deepEqual(result.events.map((value) => value.title), ["All day", "7am Tokyo"]);
  assert.equal(result.events[0].start, "2026-11-15");
  assert.equal(result.events[0].end, "2026-11-16");
  assert.equal(result.events[0].timeZone, null);
});

test("sorts before truncating unordered CalDAV resources and preserves zero-duration boundary events", async () => {
  const f = fixture();
  const items = Array.from({ length: 101 }, (_, index) => {
    const minute = String(index % 60).padStart(2, "0"), hour = String(Math.floor(index / 60)).padStart(2, "0");
    const time = `:20261115T${hour}${minute}00Z`;
    return { href: calendarUrl + index + ".ics", ics: ics(event(String(index), time, time, `SUMMARY:${index}\r\n`)) };
  });
  f.responses.push(document(...items.toReversed().map((item) => data(item.href, item.ics))), document(...items.slice(0, 100).map((item) => data(item.href, item.ics))));
  const result = await f.client.searchEvents({ start: "2026-11-15T00:00:00Z", end: "2026-11-16T00:00:00Z" });
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 100);
  assert.equal(result.events[0].title, "0");
  assert.equal(result.events.at(-1).title, "99");
  assert.ok(!f.requests[4].body.includes('/100.ics</d:href>'));
});

test("untrusted hrefs, redirects, XML entities, failed properties and missing TZID definitions fail closed", async () => {
  for (const href of ["https://icloud.com.evil.invalid/", "https://evilicloud.com/", "http://icloud.com/", "https://@icloud.com/", "https://u@icloud.com/", "https://icloud.com:444/", "https://icloud.com/\n", "https://icloud.com/?x=1"]) {
    assert.throws(() => iCloudUrl("https://icloud.com/", href), { code: "icloud_response_invalid" });
  }
  const cases = [
    new Response("", { status: 307, headers: { Location: "https://evil.invalid/" } }),
    '<!DOCTYPE x [<!ENTITY stolen SYSTEM "file:///private">]><x:multistatus xmlns:x="DAV:"/>',
    document(resource("/", '<x:current-user-principal><x:href>https://evil.invalid/</x:href></x:current-user-principal>', "404 Not Found")),
    '<x:multistatus xmlns:x="DAV:"><broken></x:multistatus>',
  ];
  for (const first of cases) {
    const f = fixture(); f.responses.splice(0, 1, first);
    await assert.rejects(f.client.listCalendars(), { code: "icloud_response_invalid" });
    assert.equal(f.requests.length, 1);
  }
  const f = fixture();
  const invalid = ics(event("bad-zone", ";TZID=Unknown/Zone:20261115T090000", ";TZID=Unknown/Zone:20261115T100000"));
  f.responses.push(document(data(calendarUrl + "zone.ics", invalid)));
  await assert.rejects(f.client.searchEvents(range), { code: "icloud_response_invalid" });
});

test("HTTP/network errors never expose credentials or response bodies, and cancellation stops requests", async () => {
  for (const [status, code] of [[401, "icloud_authentication_failed"], [403, "icloud_access_denied"], [500, "icloud_response_invalid"]]) {
    const f = fixture();
    const response = new Response("password=private raw body", { status });
    f.responses.splice(0, 1, response);
    await assert.rejects(f.client.listCalendars(), (error) => error.code === code && !error.message.includes("private"));
    assert.equal(response.body.locked, false);
    assert.equal(response.bodyUsed, true);
  }
  const f = fixture();
  f.responses[0] = async (_url, options) => { options.signal.throwIfAborted(); throw new Error("password=private"); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.listCalendars(controller.signal), { code: "request_cancelled" });
});

test("embedded DST definitions match detached recurrence identity across the seasonal offset change", async () => {
  const f = fixture();
  const newYork = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR";
  f.responses[2] = document(resource(calendarUrl, `<x:resourcetype><y:calendar/></x:resourcetype><y:supported-calendar-component-set><y:comp name="VEVENT"/></y:supported-calendar-component-set><y:calendar-timezone>${xml(newYork)}</y:calendar-timezone>`));
  const raw = ics(event("dst", ";TZID=America/New_York:20200101T090000", ";TZID=America/New_York:20200101T100000", "RRULE:FREQ=DAILY\r\nSUMMARY:Regular\r\n"),
    event("dst", ";TZID=America/New_York:20261101T110000", ";TZID=America/New_York:20261101T120000", "RECURRENCE-ID;TZID=America/New_York:20261101T090000\r\nSUMMARY:DST moved\r\n"));
  const expanded = ics(event("dst", ":20261031T130000Z", ":20261031T140000Z", "RECURRENCE-ID:20261031T130000Z\r\nSUMMARY:Regular\r\n"),
    event("dst", ":20261101T160000Z", ":20261101T170000Z", "RECURRENCE-ID:20261101T140000Z\r\nSUMMARY:DST moved\r\n"));
  f.responses.push(document(data(calendarUrl + "dst.ics", expanded)), document(data(calendarUrl + "dst.ics", raw)));
  const result = await f.client.searchEvents({ start: "2026-10-31T00:00:00Z", end: "2026-11-02T00:00:00Z" });
  assert.equal(result.events[0].start, "2026-10-31T13:00:00.000Z");
  assert.equal(result.events[0].detached, false);
  assert.equal(result.events[1].start, "2026-11-01T16:00:00.000Z");
  assert.equal(result.events[1].detached, true);
  assert.equal(result.events[1].timeZone, "America/New_York");
});

test("oversized responses stop before XML parsing", async () => {
  const f = fixture();
  f.responses[0] = new Response("x".repeat(8 * 1024 * 1024 + 1), { status: 207 });
  await assert.rejects(f.client.listCalendars(), { code: "icloud_response_too_large" });
  assert.equal(f.requests.length, 1);
});

const createInput = { title: "Meeting, one", start: "2026-11-25T09:00:00+09:00", end: "2026-11-25T10:00:00+09:00", allDay: false, timeZone: "Asia/Tokyo" };
const eventId = (uid = "one", resource = calendarUrl + "one.ics") => `icloud:event:${Buffer.from(JSON.stringify({ calendar: calendarUrl, resource, uid })).toString("base64url")}`;
const version = "2026-11-01T00:00:00.000Z";
const writableEvent = (extra = "") => ics(event("one", ":20261125T000000Z", ":20261125T010000Z", `SUMMARY:Original\r\nLAST-MODIFIED:20261101T000000Z\r\n${extra}`));

test("DAV privileges determine writable calendars and the first writable calendar is the default", async () => {
  for (const [privileges, writable] of [["<x:privilege><x:all/></x:privilege>", true], ["<x:privilege><x:write/></x:privilege>", true],
    ["<x:privilege><x:bind/><x:unbind/><x:write-content/></x:privilege>", true], ["<x:privilege><x:read/></x:privilege>", false], ["", false]]) {
    const f = fixture(privileges), result = await f.client.listCalendars();
    assert.equal(result.calendars[0].allowsModifications, writable);
    assert.equal(result.calendars[0].isDefault, writable);
    if (!writable) {
      await assert.rejects(f.client.createEvent({ ...createInput, calendarId: result.calendars[0].id }), { code: "calendar_read_only" });
      assert.equal(f.requests.length, 3);
    }
  }
});

test("create, get and update round trip UTC instants, text, alarms and untouched properties", async () => {
  const f = fixture();
  let stored;
  const put = (_url, options) => {
    assert.equal(options.headers[stored ? "If-Match" : "If-None-Match"], stored ? '"v1"' : "*");
    assert.equal(options.headers["Content-Type"], "text/calendar; charset=utf-8");
    stored = options.body;
    f.responses.unshift(document(data(_url, stored)));
    return new Response(null, { status: 200 });
  };
  f.responses.push(put);
  const created = await f.client.createEvent({ ...createInput, notes: "Line one\nLine two; fine", alarms: [{ minutesBefore: 15 }] }, undefined, "a".repeat(64));
  const component = new ICAL.Component(ICAL.parse(stored)).getFirstSubcomponent("vevent");
  assert.equal(component.getFirstPropertyValue("uid"), `bitty-${"a".repeat(64)}`);
  assert.equal(component.getFirstSubcomponent("valarm").getFirstPropertyValue("trigger").toSeconds(), -900);
  const resource = f.requests.find((value) => value.method === "PUT").url;
  f.responses.push(document(data(resource, stored)));
  const { event: detail } = await f.client.getEvent({ eventId: created.eventId });
  assert.equal(detail.start, "2026-11-25T00:00:00.000Z");
  assert.equal(detail.timeZone, "UTC");
  assert.equal(detail.notes, "Line one\nLine two; fine");
  assert.equal(detail.lastModifiedAt, created.lastModifiedAt);
  stored = stored.replace("END:VEVENT", "X-OTHER:keep\r\nEND:VEVENT");
  f.responses.push(document(data(resource, stored)), put);
  const updated = await f.client.updateEvent({ eventId: created.eventId, expectedLastModifiedAt: detail.lastModifiedAt, changes: { title: "Changed", start: "2026-11-25T11:00:00+09:00", end: "2026-11-25T12:00:00+09:00", timeZone: "Asia/Tokyo" } });
  assert.equal(updated.eventId, created.eventId);
  const changed = new ICAL.Component(ICAL.parse(stored)).getFirstSubcomponent("vevent");
  assert.equal(changed.getFirstPropertyValue("dtstart").toString(), "2026-11-25T02:00:00Z");
  assert.equal(changed.getFirstPropertyValue("x-other"), "keep");
  assert.equal(changed.getFirstPropertyValue("description"), detail.notes);
  assert.equal(changed.getAllSubcomponents("valarm").length, 1);
  f.responses.push(document(data(resource, stored)), put);
  await f.client.updateEvent({ eventId: created.eventId, expectedLastModifiedAt: updated.lastModifiedAt, changes: { start: "2026-11-25T04:00:00Z", end: "2026-11-25T05:00:00Z" } });
});

test("all-day creation keeps exclusive DATE end and validates dates and timed offsets before any PUT", async () => {
  const f = fixture();
  f.responses.push(new Response(null, { status: 201 }), new Response(null, { status: 500 }));
  await f.client.createEvent({ title: "Day", start: "2026-11-25", end: "2026-11-27", allDay: true });
  const component = new ICAL.Component(ICAL.parse(f.requests.find((value) => value.method === "PUT").body)).getFirstSubcomponent("vevent");
  assert.equal(component.getFirstPropertyValue("dtstart").isDate, true);
  assert.equal(component.getFirstPropertyValue("dtend").toString(), "2026-11-27");
  for (const input of [{ ...createInput, timeZone: undefined }, { ...createInput, start: "2026-11-25T09:00:00Z" },
    { ...createInput, title: null }, { ...createInput, start: "2026-02-30T09:00:00+09:00" }, { ...createInput, alarms: [{ minutesBefore: -1 }] },
    { title: "Bad date", start: "2026-02-30", end: "2026-03-02", allDay: true },
    { title: "Bad zone", start: "2026-11-25", end: "2026-11-26", allDay: true, timeZone: "UTC" }]) {
    await assert.rejects(f.client.createEvent(input), { code: "invalid_arguments" });
  }
  assert.equal(f.requests.filter((request) => request.method === "PUT").length, 1);
});

test("updates and deletes require a fresh timestamp and strong ETag and enforce If-Match", async () => {
  for (const [method, status] of [["updateEvent", 200], ["deleteEvent", 200], ["deleteEvent", 204], ["deleteEvent", 412]]) {
    const f = fixture();
    f.responses.push(document(data(calendarUrl + "one.ics", writableEvent())), new Response(null, { status }));
    if (method === "updateEvent") f.responses.push(document(data(calendarUrl + "one.ics", writableEvent())));
    const pending = f.client[method]({ eventId: eventId(), expectedLastModifiedAt: version, ...(method === "updateEvent" ? { changes: { notes: null, alarms: [] } } : {}) });
    if (status === 412) await assert.rejects(pending, { code: "event_changed" });
    else assert.ok(await pending);
    const write = f.requests.find((value) => ["PUT", "DELETE"].includes(value.method));
    assert.equal(write.headers["If-Match"], '"v1"');
    if (method === "updateEvent") assert.ok(!write.body.includes("DESCRIPTION:"));
  }
  for (const [expected, etag, extra, code] of [["2026-10-01T00:00:00.000Z", '"v1"', "", "event_changed"],
    [version, "", "", "event_version_unavailable"], [null, '"v1"', "", "event_version_unavailable"],
    [version, 'W/"weak"', "", "event_version_unavailable"], [version, '"v1"', "RRULE:FREQ=DAILY\r\n", "recurring_event_write_unsupported"]]) {
    const f = fixture(); f.responses.push(document(data(calendarUrl + "one.ics", writableEvent(extra), etag)));
    await assert.rejects(f.client.deleteEvent({ eventId: eventId(), expectedLastModifiedAt: expected }), { code });
    assert.equal(f.requests.filter((request) => ["PUT", "DELETE"].includes(request.method)).length, 0);
  }
});

test("patches preserve all-day and alarm state, reject moves, implicit offset changes and multi-event resources", async () => {
  for (const changes of [{ calendarId: "another-calendar" }, { allDay: true }, { start: "2026-11-25T12:00:00+09:00", end: "2026-11-25T13:00:00+09:00" }, { title: null }, { start: null }, { end: null }, { timeZone: null }]) {
    const f = fixture(); f.responses.push(document(data(calendarUrl + "one.ics", writableEvent())));
    await assert.rejects(f.client.updateEvent({ eventId: eventId(), expectedLastModifiedAt: version, changes }), { code: "invalid_arguments" });
    assert.equal(f.requests.length, 4);
  }
  const f = fixture(); f.responses.push(document(data(calendarUrl + "one.ics", ics(event("one", ":20261125T000000Z", ":20261125T010000Z"), event("other", ":20261125T000000Z", ":20261125T010000Z")))));
  await assert.rejects(f.client.deleteEvent({ eventId: eventId(), expectedLastModifiedAt: version }), { code: "icloud_response_invalid" });
  const forged = fixture();
  await assert.rejects(forged.client.deleteEvent({ eventId: eventId("one", "https://p01-caldav.icloud.com/other/one.ics"), expectedLastModifiedAt: version }), { code: "invalid_arguments" });
  assert.equal(forged.requests.length, 3);
});

test("write transport reports uncertain sent requests without retries and rejects authorization and redirects", async () => {
  for (const [response, code] of [[() => { throw new Error("private network failure"); }, "result_unknown"], [new Response(null, { status: 500 }), "result_unknown"],
    [new Response(null, { status: 403 }), "icloud_access_denied"], [new Response(null, { status: 307, headers: { location: "https://evil.invalid/" } }), "icloud_response_invalid"]]) {
    const f = fixture(); f.responses.push(response);
    await assert.rejects(f.client.createEvent(createInput), { code });
    assert.equal(f.requests.length, 4);
  }
  const f = fixture(), controller = new AbortController();
  await f.client.listCalendars();
  controller.abort();
  await assert.rejects(f.client.createEvent(createInput, controller.signal), { code: "request_cancelled" });
  assert.equal(f.requests.length, 3);
});

test("all-day conversion requires an explicit timed timezone and floating event patches retain the calendar instant", async () => {
  const allDay = fixture();
  allDay.responses.push(document(data(calendarUrl + "one.ics", ics(event("one", ";VALUE=DATE:20261125", ";VALUE=DATE:20261126", "SUMMARY:Day\r\nLAST-MODIFIED:20261101T000000Z\r\n")))));
  await assert.rejects(allDay.client.updateEvent({ eventId: eventId(), expectedLastModifiedAt: version, changes: { allDay: false, start: "2026-11-25T00:00:00Z", end: "2026-11-25T01:00:00Z" } }), { code: "invalid_arguments" });
  assert.equal(allDay.requests.length, 4);
  const f = fixture();
  f.responses.push(document(data(calendarUrl + "one.ics", ics(event("one", ":20261125T090000", ":20261125T100000", "SUMMARY:Floating\r\nLAST-MODIFIED:20261101T000000Z\r\n")))), new Response(null, { status: 204 }), new Response(null, { status: 500 }));
  const result = await f.client.updateEvent({ eventId: eventId(), expectedLastModifiedAt: version, changes: { end: "2026-11-25T11:00:00+09:00" } });
  assert.equal(result.lastModifiedAt, null);
  const written = new ICAL.Component(ICAL.parse(f.requests.find((value) => value.method === "PUT").body)).getFirstSubcomponent("vevent");
  assert.equal(written.getFirstPropertyValue("dtstart").toString(), "2026-11-25T00:00:00Z");
  assert.equal(written.getFirstPropertyValue("dtend").toString(), "2026-11-25T02:00:00Z");
});

test("patching an untitled event preserves the absent summary and keeps unspecified all-day dates and alarms", async () => {
  const f = fixture();
  const original = ics(event("one", ";VALUE=DATE:20261125", ";VALUE=DATE:20261127", "LAST-MODIFIED:20261101T000000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Existing\r\nEND:VALARM\r\n"));
  f.responses.push(document(data(calendarUrl + "one.ics", original)), new Response(null, { status: 204 }), new Response(null, { status: 500 }));
  await f.client.updateEvent({ eventId: eventId(), expectedLastModifiedAt: version, changes: { notes: "Added" } });
  const updated = new ICAL.Component(ICAL.parse(f.requests.find((value) => value.method === "PUT").body)).getFirstSubcomponent("vevent");
  assert.equal(updated.hasProperty("summary"), false);
  assert.equal(updated.getFirstPropertyValue("dtstart").toString(), "2026-11-25");
  assert.equal(updated.getFirstPropertyValue("dtend").toString(), "2026-11-27");
  assert.equal(updated.getFirstSubcomponent("valarm").getFirstPropertyValue("trigger").toSeconds(), -900);
});
