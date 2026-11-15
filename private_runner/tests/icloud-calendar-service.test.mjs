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
  const request = (tool, args = {}) => ({ method: "item/tool/call", params: { namespace: "calendar", tool, arguments: args, threadId: "thread", turnId: "turn" } });
  assert.equal(await dispatch(request("calendar_search_events")), null);
  const disconnected = await dispatch(request("calendar_get_event", { eventId: "icloud:event:old" }));
  assert.equal(JSON.parse(disconnected.contentItems[0].text).error.code, "icloud_not_connected");
  await f.connect();
  const coldDispatch = createCalendarToolDispatcher({ cloudService: createICloudCalendarService(f.options) });
  const result = JSON.parse((await coldDispatch(request("calendar_list_calendars"))).contentItems[0].text);
  assert.equal(result.ok, true);
  for (const tool of ["calendar_create_event", "calendar_update_event", "calendar_delete_event"]) {
    assert.equal(JSON.parse((await dispatch(request(tool))).contentItems[0].text).error.code, "icloud_read_only");
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
