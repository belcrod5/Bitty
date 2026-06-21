import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test("canonical directory identity uses a stable absolute real path", async () => {
  const resolved = await __TESTING__.resolveToolRoot(".", { create: false });
  assert.equal(
    await __TESTING__.resolveCanonicalDirectoryIdentity("."),
    resolved.rootReal
  );
});

test("directory explorer returns absolute identities", async () => {
  const resolved = await __TESTING__.resolveToolRoot(".", { create: false });
  const result = await __TESTING__.listLlmDirectories(".");
  assert.equal(result.basePath, resolved.rootReal);
  assert.equal(result.rootPath.startsWith("/"), true);
  assert.equal(result.directories.every((entry) => entry.path.startsWith("/")), true);
  assert.equal(result.files.every((entry) => entry.path.startsWith("/")), true);
});

test("canonical directory identity makes missing logical directories absolute", async () => {
  assert.equal(
    await __TESTING__.resolveCanonicalDirectoryIdentity("missing/directory-for-identity-test"),
    `${process.cwd()}/missing/directory-for-identity-test`
  );
});

test("session APIs keep their empty behavior for a missing directory", async () => {
  const directory = "missing/directory-for-session-test";
  const sessions = await __TESTING__.listLlmSessions(directory, { source: "all" });
  assert.equal(sessions.directory, `${process.cwd()}/${directory}`);
  assert.deepEqual(sessions.sessions, []);

  const messages = await __TESTING__.listLlmSessionMessages("missing-session-id", {
    directory,
    source: "all",
  });
  assert.equal(messages.directory, `${process.cwd()}/${directory}`);
  assert.equal(messages.found, false);
  assert.deepEqual(messages.messages, []);
});
