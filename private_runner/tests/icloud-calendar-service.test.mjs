import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { createICloudCalendarService, iCloudError } from "../src/icloud-calendar-service.mjs";
import { createCalendarToolDispatcher } from "../src/calendar-tool-service.mjs";

const owner = "owner:test", context = { ownerSubjectId: owner, sessionId: "session-1" };
const input = { account: "test@example.invalid", password: "abcd-efgh-ijkl-mnop" };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-icloud-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), calls = [];
  let failure, clock = Date.now();
  const options = { directory, ownerSubjectId: owner, now: () => clock,
    keyProvider: async () => key, clientFactory: (credentials) => ({
      async listCalendars() { calls.push({ tool: "list", credentials }); if (failure) throw failure; return { calendars: [{ id: "icloud:calendar:one" }] }; },
      async searchEvents() { calls.push({ tool: "search", credentials }); if (failure) throw failure; return { events: [] }; },
      async getEvent() { return { event: { id: "icloud:event:one" } }; },
      async createEvent(args, signal, requestId) { calls.push({ tool: "create", args, requestId }); if (failure) throw failure; return { eventId: "icloud:event:created", lastModifiedAt: null }; },
      async updateEvent(args) { calls.push({ tool: "update", args }); if (failure) throw failure; return { eventId: "icloud:event:updated", lastModifiedAt: null }; },
      async deleteEvent(args) { calls.push({ tool: "delete", args }); if (failure) throw failure; return { deletedEventId: "icloud:event:deleted" }; },
    }) };
  const service = createICloudCalendarService(options);
  const connect = async () => service.save(await service.test(input, context), context);
  return { directory, service, options, calls, connect, fail: (value) => { failure = value; }, advance: (ms) => { clock += ms; } };
}

test("test does not persist credentials; only a current owner/session-bound test can save encrypted state", async (t) => {
  const f = await fixture(t);
  const tested = await f.service.test({ ...input, password: " abcd- efgh\u3000-ijkl-\tmnop " }, context);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(f.calls[0].credentials.password, input.password);
  await assert.rejects(f.service.save(tested, { ...context, sessionId: "other" }), { code: "icloud_test_required" });
  await assert.rejects(f.service.save({ enabled: true }, context), { code: "icloud_test_required" });
  const status = await f.service.save(tested, context);
  assert.equal(status.enabled, true);
  assert.equal(status.account, input.account);
  assert.equal(Object.hasOwn(status, "password"), false);
  const file = path.join(f.directory, "credentials.json"), raw = await fs.readFile(file, "utf8");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.ok(!raw.includes(input.password) && !raw.includes(input.account));
  assert.deepEqual(await createICloudCalendarService(f.options).status(), status);
  await assert.rejects(f.service.save(tested, context), { code: "icloud_test_required" });
});

test("failed or stale tests never replace existing connection and reenabling checks saved credentials", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const original = await fs.readFile(path.join(f.directory, "credentials.json"), "utf8");
  f.fail(iCloudError("icloud_authentication_failed", 401));
  await assert.rejects(f.service.test(input, context), { code: "icloud_authentication_failed" });
  assert.equal(await fs.readFile(path.join(f.directory, "credentials.json"), "utf8"), original);
  await f.service.setEnabled(false);
  await assert.rejects(f.service.setEnabled(true), { code: "icloud_authentication_failed" });
  assert.equal((await f.service.status()).enabled, false);
  f.fail(null);
  const tested = await f.service.test(input, context);
  f.advance(5 * 60000);
  await assert.rejects(f.service.save(tested, context), { code: "icloud_test_required" });
  await f.service.disconnect();
  assert.equal((await f.service.status()).configured, false);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("normal Apple passwords are rejected before contacting iCloud", async (t) => {
  const f = await fixture(t);
  for (const password of ["usual-password", "", "abcd-efgh-ijkl-mno!", " \t\u3000"]) {
    await assert.rejects(f.service.test({ ...input, password }, context), { code: "icloud_credentials_invalid" });
  }
  assert.deepEqual(f.calls, []);
});

test("storage rejects insecure modes, symlinks, corrupt encryption, and changed owner", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const file = path.join(f.directory, "credentials.json");
  await assert.rejects(createICloudCalendarService({ ...f.options, ownerSubjectId: "owner:other" }).status(), { code: "icloud_storage_unavailable" });
  await fs.chmod(file, 0o644);
  await assert.rejects(createICloudCalendarService(f.options).status(), { code: "icloud_storage_unavailable" });
  await fs.chmod(file, 0o600);
  await fs.rename(file, file + ".real");
  await fs.symlink(file + ".real", file);
  await assert.rejects(createICloudCalendarService(f.options).status(), { code: "icloud_storage_unavailable" });
  await fs.unlink(file);
  await fs.writeFile(file, "{}", { mode: 0o600 });
  await assert.rejects(createICloudCalendarService(f.options).status(), { code: "icloud_storage_unavailable" });
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(createICloudCalendarService(f.options).status(), { code: "icloud_storage_unavailable" });
});

test("cloud dispatch runs with no device and never forwards cloud errors or writes to EventKit", async (t) => {
  const f = await fixture(t), dispatch = createCalendarToolDispatcher({ cloudService: f.service });
  const request = (tool, args = {}) => ({ method: "item/tool/call", params: { namespace: "calendar", tool, arguments: args, threadId: "thread", turnId: "turn", callId: tool } });
  assert.equal(await dispatch(request("calendar_search_events")), null);
  const disconnected = await dispatch(request("calendar_get_event", { eventId: "icloud:event:old" }));
  assert.equal(JSON.parse(disconnected.contentItems[0].text).error.code, "icloud_not_connected");
  await f.connect();
  const coldDispatch = createCalendarToolDispatcher({ cloudService: createICloudCalendarService(f.options) });
  const result = JSON.parse((await coldDispatch(request("calendar_list_calendars"))).contentItems[0].text);
  assert.equal(result.ok, true);
  for (const tool of ["calendar_create_event", "calendar_update_event", "calendar_delete_event"]) {
    assert.equal(JSON.parse((await dispatch(request(tool))).contentItems[0].text).ok, true);
  }
  f.fail(new Error("credential contents must never escape"));
  const failure = JSON.parse((await dispatch(request("calendar_search_events"))).contentItems[0].text);
  assert.equal(failure.error.code, "icloud_connection_failed");
  assert.ok(!JSON.stringify(failure).includes("credential contents"));
});

test("concurrent first-use status and tools share one decrypt and cannot overwrite a saved connection", async (t) => {
  const f = await fixture(t);
  await f.connect();
  let keyReads = 0;
  const service = createICloudCalendarService({ ...f.options, keyProvider: async (...args) => {
    keyReads++; await new Promise((resolve) => setImmediate(resolve)); return f.options.keyProvider(...args);
  } });
  const results = await Promise.all([service.status(), service.status(), service.execute("calendar_list_calendars", {})]);
  assert.equal(keyReads, 1);
  assert.equal(results[0].enabled, true);
  assert.equal(results[1].enabled, true);
  assert.equal(results[2].calendars.length, 1);
});

test("disabling cloud while a read is pending suppresses data from the previous connection", async (t) => {
  const f = await fixture(t);
  await f.connect();
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const service = createICloudCalendarService({ ...f.options, clientFactory: () => ({
    listCalendars: async () => { started(); await new Promise((resolve) => { release = resolve; }); return { calendars: [{ title: "old account" }] }; },
  }) });
  const pending = service.execute("calendar_list_calendars", {});
  await ready;
  await service.setEnabled(false);
  release();
  await assert.rejects(pending, { code: "icloud_not_connected" });
});

const writeId = "a".repeat(64);
test("write receipts deduplicate concurrent/restarted calls, canonicalize arguments and reject conflicts", async (t) => {
  const f = await fixture(t); await f.connect();
  const args = { title: "private event", nested: { b: 2, a: 1 } };
  const results = await Promise.all([f.service.execute("calendar_create_event", args, undefined, writeId), f.service.execute("calendar_create_event", args, undefined, writeId)]);
  assert.deepEqual(results[0], results[1]);
  const restarted = createICloudCalendarService(f.options);
  assert.deepEqual(await restarted.execute("calendar_create_event", { nested: { a: 1, b: 2 }, title: "private event" }, undefined, writeId), results[0]);
  assert.equal(f.calls.filter((call) => call.tool === "create").length, 1);
  await assert.rejects(restarted.execute("calendar_create_event", { title: "different" }, undefined, writeId), { code: "request_conflict" });
  await assert.rejects(restarted.execute("calendar_delete_event", args, undefined, writeId), { code: "request_conflict" });
  const receipt = (await fs.readdir(f.directory)).find((value) => value.startsWith("write-"));
  const saved = await fs.readFile(path.join(f.directory, receipt), "utf8");
  assert.ok(!saved.includes(args.title));
  assert.equal((await fs.stat(path.join(f.directory, receipt))).mode & 0o777, 0o600);
  await f.service.disconnect(); await f.connect();
  assert.deepEqual(await f.service.execute("calendar_create_event", args, undefined, writeId), results[0]);
  assert.equal(f.calls.filter((call) => call.tool === "create").length, 1);
});

test("unfinished and failed writes survive restarts and are never automatically sent again", async (t) => {
  const f = await fixture(t); await f.connect();
  let release, started, calls = 0;
  const ready = new Promise((resolve) => { started = resolve; });
  const options = { ...f.options, clientFactory: () => ({ async createEvent() {
    calls++; started(); await new Promise((resolve) => { release = resolve; }); throw iCloudError("result_unknown");
  } }) };
  const service = createICloudCalendarService(options);
  const pending = service.execute("calendar_create_event", {}, undefined, writeId);
  await ready;
  await assert.rejects(createICloudCalendarService(options).execute("calendar_create_event", {}, undefined, writeId), { code: "result_unknown" });
  release();
  await assert.rejects(pending, { code: "result_unknown" });
  await assert.rejects(createICloudCalendarService(options).execute("calendar_create_event", {}, undefined, writeId), { code: "result_unknown" });
  assert.equal(calls, 1);
});

test("write execution and disconnect are serialized and an owner change suppresses the result", async (t) => {
  const f = await fixture(t); await f.connect();
  let release, started, currentOwner = owner;
  const ready = new Promise((resolve) => { started = resolve; });
  const service = createICloudCalendarService({ ...f.options, ownerSubjectId: () => currentOwner, clientFactory: () => ({ async createEvent() {
    started(); await new Promise((resolve) => { release = resolve; }); return { eventId: "private-result" };
  } }) });
  const pending = service.execute("calendar_create_event", {}, undefined, writeId);
  await ready;
  currentOwner = "owner:other";
  release();
  await assert.rejects(pending, { code: "icloud_storage_unavailable" });
  currentOwner = owner;
  assert.deepEqual(await service.execute("calendar_create_event", {}, undefined, writeId), { eventId: "private-result" });
  await service.disconnect();
  assert.equal((await service.status()).enabled, false);
});

test("cloud writes require call identity, keep error details private and scope receipts to the account", async (t) => {
  const f = await fixture(t); await f.connect();
  const dispatch = createCalendarToolDispatcher({ cloudService: f.service });
  const request = { method: "item/tool/call", params: { namespace: "calendar", tool: "calendar_create_event", arguments: {}, threadId: "thread", turnId: "turn" } };
  assert.equal(JSON.parse((await dispatch(request)).contentItems[0].text).error.code, "invalid_arguments");
  assert.equal(f.calls.filter((call) => call.tool === "create").length, 0);
  request.params.callId = "create-1";
  f.fail(new Error("credentials must never escape"));
  const failure = await dispatch(request);
  assert.equal(JSON.parse(failure.contentItems[0].text).error.code, "result_unknown");
  assert.ok(!JSON.stringify(failure).includes("credentials"));
  f.fail(null);
  await f.service.save(await f.service.test({ ...input, account: "other@example.invalid" }, context), context);
  assert.equal(JSON.parse((await dispatch(request)).contentItems[0].text).ok, true);
  assert.equal(f.calls.filter((call) => call.tool === "create").length, 2);
});

test("connection changes wait for executing writes and receipt corruption fails closed", async (t) => {
  const f = await fixture(t); await f.connect();
  let release, started, disconnected = false;
  const ready = new Promise((resolve) => { started = resolve; });
  const service = createICloudCalendarService({ ...f.options, clientFactory: () => ({ async createEvent() {
    started(); await new Promise((resolve) => { release = resolve; }); return { eventId: "created" };
  } }) });
  const write = service.execute("calendar_create_event", {}, undefined, writeId);
  await ready;
  const disconnect = service.disconnect().then(() => { disconnected = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnected, false);
  release(); await write; await disconnect;
  await f.connect();
  const receipt = (await fs.readdir(f.directory)).find((value) => value.startsWith("write-"));
  await fs.writeFile(path.join(f.directory, receipt), "corrupt");
  await assert.rejects(f.service.execute("calendar_create_event", {}, undefined, writeId), { code: "result_unknown" });
  assert.equal(f.calls.filter((call) => call.tool === "create").length, 0);
});
