import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

test("canonical directory identity preserves missing logical directories", async () => {
  assert.equal(
    await __TESTING__.resolveCanonicalDirectoryIdentity("missing/directory-for-identity-test"),
    "missing/directory-for-identity-test"
  );
});

test("session APIs keep their empty behavior for a missing directory", async () => {
  const directory = "missing/directory-for-session-test";
  const sessions = await __TESTING__.listLlmSessions(directory, { source: "all" });
  assert.equal(sessions.directory, directory);
  assert.deepEqual(sessions.sessions, []);

  const messages = await __TESTING__.listLlmSessionMessages("missing-session-id", {
    directory,
    source: "all",
  });
  assert.equal(messages.directory, directory);
  assert.equal(messages.found, false);
  assert.deepEqual(messages.messages, []);
});
