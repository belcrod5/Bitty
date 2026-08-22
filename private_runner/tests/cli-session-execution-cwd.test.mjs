import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";

const {
  resolveCliSessionEntryExecutionCwd,
  WORKSPACE_ROOT,
} = (await import("../src/server-runtime.mjs")).__TESTING__;

// Agent Backendへ渡すセッションcwdは実行identity(絶対パス)。workspace外の
// セッションを一覧スコープ(workspace相対)で解決するとllm_rootへ誤収束し、
// resume/history/handoffがsession_cwd_mismatchになる回帰を防ぐ。
test("resolves the native absolute cwd for sessions outside the workspace root", () => {
  const outside = "/Volumes/external/work/outside-project";
  assert.equal(
    resolveCliSessionEntryExecutionCwd({ cwd: outside, directory: "" }),
    outside,
  );
});

test("resolves a workspace-relative scope directory against the workspace root", () => {
  assert.equal(
    resolveCliSessionEntryExecutionCwd({ cwd: "", directory: "sub/project" }),
    path.resolve(WORKSPACE_ROOT, "sub/project").split(path.sep).join("/"),
  );
});

test("returns empty (fail-closed upstream) when the entry has no cwd information", () => {
  assert.equal(resolveCliSessionEntryExecutionCwd({ cwd: "", directory: "" }), "");
  assert.equal(resolveCliSessionEntryExecutionCwd(null), "");
});
