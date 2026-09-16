import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../src/server-runtime.mjs", import.meta.url), "utf8");

test("auth admission keeps constructor cleanup and relay identity rules at the source boundary", () => {
  assert.match(source, /try \{\s*return createCodexAppServerClient\(/);
  assert.match(source, /catch \(error\) \{\s*authLease\?\.\(\);\s*throw error;/);
  assert.match(source, /meta\.id !== null && params\.authLeaseAcquired !== true/);
  assert.match(source, /Codex RPC id already in flight/);
  assert.match(source, /releaseCodexRelayTurnLease\(relay\)/);
});
