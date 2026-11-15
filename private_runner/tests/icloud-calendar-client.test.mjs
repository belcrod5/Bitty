import assert from "node:assert/strict";
import test from "node:test";
import { createICloudCalendarClient, iCloudUrl } from "../src/icloud-calendar-client.mjs";

const CAL = "urn:ietf:params:xml:ns:caldav";
const calendarUrl = "https://p01-caldav.icloud.com/user/cal/";
const zone = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR";
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const resource = (href, properties, status = "200 OK") => `<x:response><x:href>${xml(href)}</x:href><x:propstat><x:prop>${properties}</x:prop><x:status>HTTP/1.1 ${status}</x:status></x:propstat></x:response>`;
const document = (...items) => `<x:multistatus xmlns:x="DAV:" xmlns:y="${CAL}">${items.join("")}</x:multistatus>`;
const data = (href, ics) => resource(href, `<y:calendar-data>${xml(ics)}</y:calendar-data>`);
const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const event = (uid, start, end, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART${start}\r\nDTEND${end}\r\n${extra}END:VEVENT`;
function fixture() {
  const requests = [];
  const responses = [
    document(resource("/", '<x:current-user-principal><x:href>/user/</x:href></x:current-user-principal>')),
    document(resource("/user/", `<y:calendar-home-set><x:href>https://p01-caldav.icloud.com/user/</x:href></y:calendar-home-set>`)),
    document(resource(calendarUrl, `<x:displayname>Work &amp; Life</x:displayname><x:resourcetype><y:calendar/></x:resourcetype><y:supported-calendar-component-set><y:comp name="VEVENT"/></y:supported-calendar-component-set><y:calendar-timezone>${xml(zone)}</y:calendar-timezone>`),
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

test("namespace-correct discovery and folded/escaped event details use the read-only tool contract", async () => {
  const f = fixture();
  const item = ics(event("one", ":20261115T010000Z", ":20261115T020000Z", "SUMMARY:Long\\, title\r\n  folded\r\nDESCRIPTION:Line one\\nLine two\\; fine\r\nLOCATION:Room\\, A\r\nLAST-MODIFIED:20261101T000000Z\r\n"));
  f.responses.push(document(data(calendarUrl + "one.ics", item)), document(data(calendarUrl + "one.ics", item)));
  const result = await f.client.searchEvents(range);
  assert.equal(result.events[0].title, "Long, title folded");
  assert.equal(result.events[0].allowsModifications, false);
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
  f.responses.push(document(data(calendarUrl + "repeat.ics", raw)));
  await assert.rejects(f.client.getEvent({ eventId: result.events[1].id }), { code: "invalid_arguments" });
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
