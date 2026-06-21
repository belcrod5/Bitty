import assert from "node:assert/strict";
import test from "node:test";
import { fetchGitBranches } from "../src/git-branches.mjs";

test("lists local and remote branches without the remote HEAD alias", async () => {
  const calls = [];
  const branches = await fetchGitBranches({
    cwd: "/workspace",
    timeoutMs: 12000,
    runCommandWithCapture: async (...args) => {
      calls.push(args);
      return {
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout: [
          "refs/heads/main\tmain",
          "refs/heads/feature/z\tfeature/z",
          "refs/remotes/origin/HEAD\torigin/HEAD",
          "refs/remotes/origin/main\torigin/main",
        ].join("\n") + "\n",
      };
    },
  });

  assert.deepEqual(branches, [
    { name: "feature/z", kind: "local" },
    { name: "main", kind: "local" },
    { name: "origin/main", kind: "remote" },
  ]);
  assert.deepEqual(calls[0], [
    "git",
    [
      "-C",
      "/workspace",
      "for-each-ref",
      "--format=%(refname)%09%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ],
    { timeoutMs: 12000, maxOutputBytes: 128 * 1024 },
  ]);
});

test("reports git branch listing failures", async () => {
  await assert.rejects(
    fetchGitBranches({
      cwd: "/workspace",
      timeoutMs: 12000,
      runCommandWithCapture: async () => ({
        exitCode: 128,
        timedOut: false,
        stderr: "not a repository",
        stdout: "",
      }),
    }),
    /git command failed \(128\).*not a repository/
  );
});

test("rejects truncated branch list output", async () => {
  await assert.rejects(
    fetchGitBranches({
      cwd: "/workspace",
      timeoutMs: 12000,
      runCommandWithCapture: async () => ({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout: `${"x".repeat(128 * 1024 - 1)}\n`,
      }),
    }),
    /branch list output was truncated/
  );
});
