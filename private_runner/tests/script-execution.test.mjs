import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "script-execution-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("rejects absolute script paths without explicit confirmation", async () => {
  await withTempDir(async (root) => {
    const scriptPath = path.join(root, "external.sh");
    await writeFile(scriptPath, "echo external\n");

    await assert.rejects(
      __TESTING__.resolveWorkspaceShellScriptTarget(scriptPath),
      /absolute script path requires confirmation/
    );
  });
});

test("accepts confirmed absolute script paths outside the workspace", async () => {
  await withTempDir(async (root) => {
    const nestedDir = path.join(root, "nested");
    const scriptPath = path.join(nestedDir, "external.sh");
    await mkdir(nestedDir);
    await writeFile(scriptPath, "echo external\n");
    const scriptRealPath = await realpath(scriptPath);
    const nestedRealPath = await realpath(nestedDir);

    const target = await __TESTING__.resolveWorkspaceShellScriptTarget(scriptPath, {
      allowExternal: true,
    });

    assert.equal(target.resolved.realPath, scriptRealPath);
    assert.equal(target.resolved.relativePath, scriptRealPath);
    assert.equal(target.cwdAbs, nestedRealPath);
  });
});
