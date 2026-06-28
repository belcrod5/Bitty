import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let hooks = null;
let sessionStoreRoot = "";

async function makeCtx(rootPath, overrides = {}) {
  const rootReal = await realpath(rootPath);
  return {
    rootReal,
    rootPathAliases: [],
    sessionId: "test-session",
    requestToolApproval: null,
    ...overrides,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llm-harness-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runLocalCommand(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    throw new Error(`command failed: ${command} ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

test.before(async () => {
  sessionStoreRoot = await mkdtemp(path.join(os.tmpdir(), "llm-harness-sessions-"));
  process.env.RUNNER_SKIP_SERVER_START = "1";
  process.env.RUNNER_MOCK = "1";
  process.env.RUNNER_TOKEN = process.env.RUNNER_TOKEN || "test-token";
  process.env.CODEX_CLI_SESSIONS_DIR = path.join(sessionStoreRoot, "sessions");
  process.env.CLI_SESSION_INDEX_PATH = path.join(sessionStoreRoot, "cli_sessions_index.json");
  const mod = await import("../src/server-runtime.mjs");
  hooks = mod.__TESTING__;
  assert.ok(hooks, "__TESTING__ export must exist");
});

test.after(async () => {
  if (!sessionStoreRoot) return;
  await rm(sessionStoreRoot, { recursive: true, force: true });
  sessionStoreRoot = "";
});

test("client media types include videos and common images", () => {
  assert.equal(hooks.getClientMediaMimeType("clip.mp4"), "video/mp4");
  assert.equal(hooks.getClientMediaMimeType("photo.JPEG"), "image/jpeg");
  assert.equal(hooks.getClientMediaMimeType("image.webp"), "image/webp");
  assert.equal(hooks.getClientMediaMimeType("photo.heic"), "image/heic");
  assert.equal(hooks.getClientMediaMimeType("document.pdf"), "");
});

test("content disposition supports Japanese file names without non-ASCII headers", () => {
  const value = hooks.buildInlineContentDisposition("日本語の画像.png");

  assert.equal(
    value,
    "inline; filename=\"_.png\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E7%94%BB%E5%83%8F.png"
  );
  assert.doesNotThrow(() => validateHeaderValue("content-disposition", value));
});

test("HTTP runner auth only accepts Bearer tokens", () => {
  assert.equal(
    hooks.parseHttpBearerToken({
      headers: { authorization: "Bearer test-token" },
    }),
    "test-token"
  );
  assert.equal(
    hooks.parseHttpBearerToken({
      url: "/codex-ws-debug?token=test-token",
      headers: {},
    }),
    ""
  );
});

test("queued Codex turns do not publish app-server notifications into relays", async () => {
  const source = await readFile(new URL("../src/server-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /publishCodexQueuedTurnRpcToRelay/);
  assert.doesNotMatch(source, /queued_turn_to_client_rpc/);
  assert.doesNotMatch(source, /createCodexRpcClient\(\{[\s\S]*?onRawMessage/);
});

test("client file paths resolve inside the selected root only", async () => {
  await withTempDir(async (root) => {
    const nested = path.join(root, "nested");
    await writeFile(path.join(root, "outside.txt"), "outside", "utf8");
    await mkdir(nested);
    const target = path.join(nested, "image.png");
    await writeFile(target, "image", "utf8");
    const targetReal = await realpath(target);

    const relative = await hooks.resolveClientFilePath("image.png", nested);
    assert.equal(relative.realPath, targetReal);

    const absolute = await hooks.resolveClientFilePath(target, nested);
    assert.equal(absolute.realPath, targetReal);

    await assert.rejects(
      hooks.resolveClientFilePath(path.join(root, "outside.txt"), nested),
      /path escapes root directory/
    );
  });
});

test("read_file_range handles boundaries, clipping, and out-of-bounds", async () => {
  await withTempDir(async (root) => {
    const ctx = await makeCtx(root);
    await writeFile(path.join(root, "sample.txt"), "a\nb\nc\n", "utf8");

    const first = await hooks.runReadFileRangeTool({
      path: "sample.txt",
      start_line: 1,
      end_line: 2,
    }, ctx);
    assert.equal(first.content, "a\nb");
    assert.equal(first.lineCount, 2);

    const last = await hooks.runReadFileRangeTool({
      path: "sample.txt",
      start_line: 3,
      end_line: 3,
    }, ctx);
    assert.equal(last.content, "c");
    assert.equal(last.totalLines, 3);
    assert.equal(last.clipped, false);

    const clipped = await hooks.runReadFileRangeTool({
      path: "sample.txt",
      start_line: 2,
      end_line: 99,
    }, ctx);
    assert.equal(clipped.content, "b\nc");
    assert.equal(clipped.lineCount, 2);
    assert.equal(clipped.totalLines, 3);
    assert.equal(clipped.clipped, true);
    assert.equal(clipped.requestedEndLine, 99);
    assert.equal(clipped.effectiveEndLine, 3);
    assert.equal(clipped.endLine, 3);

    await assert.rejects(
      () => hooks.runReadFileRangeTool({ path: "sample.txt", start_line: 4, end_line: 4 }, ctx),
      (err) => err?.toolErrorCode === "range_out_of_bounds"
    );
  });
});

test("apply_patch supports create/update/delete and mismatch error", async () => {
  await withTempDir(async (root) => {
    const ctx = await makeCtx(root);

    await hooks.runApplyPatchTool({
      patch: [
        "*** Begin Patch",
        "*** Add File: note.txt",
        "+hello",
        "+world",
        "*** End Patch",
      ].join("\n"),
    }, ctx);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "hello\nworld\n");

    await hooks.runApplyPatchTool({
      patch: [
        "*** Begin Patch",
        "*** Update File: note.txt",
        "@@",
        "-hello",
        "+HELLO",
        " world",
        "*** End Patch",
      ].join("\n"),
    }, ctx);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "HELLO\nworld\n");

    await assert.rejects(
      () => hooks.runApplyPatchTool({
        patch: [
          "*** Begin Patch",
          "*** Update File: note.txt",
          "@@",
          "-missing",
          "+new",
          "*** End Patch",
        ].join("\n"),
      }, ctx),
      (err) => err?.toolErrorCode === "patch_hunk_mismatch"
    );

    await hooks.runApplyPatchTool({
      patch: [
        "*** Begin Patch",
        "*** Delete File: note.txt",
        "*** End Patch",
      ].join("\n"),
    }, ctx);
    await assert.rejects(() => readFile(path.join(root, "note.txt"), "utf8"));
  });
});

test("run_tests returns structured success and failure responses", async () => {
  await withTempDir(async (root) => {
    const ctx = await makeCtx(root);
    const ok = await hooks.runTestsTool({
      target: "node -e \"process.exit(0)\"",
    }, ctx);
    assert.equal(ok.ok, true);
    assert.equal(ok.exitCode, 0);
    assert.equal(typeof ok.stdout, "string");
    assert.equal(typeof ok.stderr, "string");

    const ng = await hooks.runTestsTool({
      target: "node -e \"process.exit(3)\"",
    }, ctx);
    assert.equal(ng.ok, false);
    assert.equal(ng.exitCode, 3);
    assert.equal(typeof ng.stdout, "string");
    assert.equal(typeof ng.stderr, "string");
  });
});

test("run_command_sandboxed enforces allow/deny rules", async () => {
  await withTempDir(async (root) => {
    const ctx = await makeCtx(root);
    await assert.rejects(
      () => hooks.runCommandSandboxedTool({
        command: "echo",
        args: ["hello"],
      }, ctx),
      (err) => /interactive approval/i.test(String(err?.message || ""))
    );

    const approvalRequests = [];
    const approvedCtx = await makeCtx(root, {
      requestToolApproval: async (request) => {
        approvalRequests.push(request);
        return { approved: true };
      },
    });
    const allowed = await hooks.runCommandSandboxedTool({
      command: "echo",
      args: ["hello"],
    }, approvedCtx);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.exitCode, 0);
    assert.match(allowed.stdout, /hello/);
    assert.equal(approvalRequests.length, 1);

    const autoApproved = await hooks.runCommandSandboxedTool({
      command: "which",
      args: ["node"],
    }, ctx);
    assert.equal(autoApproved.code === "ok" || autoApproved.code === "command_failed", true);
    assert.equal(autoApproved.command, "which");

    const denied = await hooks.runCommandSandboxedTool({
      command: "rm",
      args: ["-rf", "tmp"],
    }, ctx);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "command_denied");
  });
});

test("run_command_sandboxed injects shared tool execution env", async () => {
  await withTempDir(async (root) => {
    const approvalRequests = [];
    const approvedCtx = await makeCtx(root, {
      sessionId: "99999999-9999-4999-8999-999999999999",
      requestToolApproval: async (request) => {
        approvalRequests.push(request);
        return { approved: true };
      },
    });
    const expectedBinDir = path.resolve(process.cwd(), "private_runner/bin");
    const result = await hooks.runCommandSandboxedTool({
      command: "node",
      args: [
        "-e",
        "const path=require('node:path'); const expected=process.argv[1]; process.stdout.write(JSON.stringify({sid: process.env.YOUTUBE_FAVORITES_SESSION_ID || '', hasBin: (process.env.PATH || '').split(path.delimiter).includes(expected)}));",
        expectedBinDir,
      ],
    }, approvedCtx);
    assert.equal(result.ok, true);
    const parsed = JSON.parse(String(result.stdout || "{}"));
    assert.equal(parsed.sid, "99999999-9999-4999-8999-999999999999");
    assert.equal(parsed.hasBin, true);
    assert.equal(approvalRequests.length, 1);
  });
});

test("youtube video id extraction supports run_command_sandboxed toolrun outputs", () => {
  const extracted = hooks.extractYouTubeVideoIdsFromToolResult(
    "run_command_sandboxed",
    {
      command: "toolrun",
      args: ["youtube_favorites", "0"],
    },
    {
      result: {
        stdout: JSON.stringify({
          results: [
            { videoId: "5z5TDvzHs40" },
            { videoId: "5z5TDvzHs40" },
            { videoId: "short" },
          ],
        }),
      },
    }
  );
  assert.deepEqual(extracted, ["5z5TDvzHs40"]);
});

test("search -> read_file_range -> apply_patch -> run_tests -> git_diff chain works in one flow", async () => {
  await withTempDir(async (root) => {
    const ctx = await makeCtx(root);
    runLocalCommand(root, "git", ["init"]);
    runLocalCommand(root, "git", ["config", "user.email", "llm-harness@example.com"]);
    runLocalCommand(root, "git", ["config", "user.name", "LLM Harness"]);
    await writeFile(path.join(root, "app.txt"), "hello\nline2\n", "utf8");
    runLocalCommand(root, "git", ["add", "app.txt"]);
    runLocalCommand(root, "git", ["commit", "-m", "init"]);

    const search = await hooks.executeLlmFileToolCall("search_text", {
      pattern: "hello",
      path: ".",
    }, ctx);
    assert.equal(search.matches.length, 1);

    const range = await hooks.executeLlmFileToolCall("read_file_range", {
      path: "app.txt",
      start_line: 1,
      end_line: 1,
    }, ctx);
    assert.equal(range.content, "hello");

    const patched = await hooks.executeLlmFileToolCall("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: app.txt",
        "@@",
        "-hello",
        "+HELLO",
        " line2",
        "*** End Patch",
      ].join("\n"),
    }, ctx);
    assert.equal(patched.ok, true);
    assert.equal(patched.filesChanged.length, 1);

    const tests = await hooks.executeLlmFileToolCall("run_tests", {
      target: "node -e \"process.exit(0)\"",
    }, ctx);
    assert.equal(tests.ok, true);
    assert.equal(tests.exitCode, 0);

    const diff = await hooks.executeLlmFileToolCall("git_diff", {
      path: "app.txt",
    }, ctx);
    assert.equal(diff.ok, true);
    assert.equal(diff.changedFiles.includes("app.txt"), true);
    assert.match(diff.diffText, /\+HELLO/);
  });
});

test("runCodexWithFileTools enforces max tool rounds and emits progress", async () => {
  await withTempDir(async (root) => {
    const rootReal = await realpath(root);
    const progressEvents = [];
    let responseSeq = 0;
    await assert.rejects(
      () => hooks.runCodexWithFileTools({
        transcript: "round-limit-test",
        messages: [],
        instructions: "",
        sessionId: "tool-round-limit-session",
        codexOptions: {
          modelInfo: {
            model: "openai-codex/gpt-5.4-mini",
            modelRef: "openai-codex/gpt-5.4-mini",
          },
          reasoningEffort: "low",
        },
        resolvedRoot: {
          rootReal,
          relativeRoot: ".",
        },
        onProgress: (event) => {
          progressEvents.push(event);
        },
        testHooks: {
          maxToolRounds: 2,
          createCodexResponse: async () => {
            responseSeq += 1;
            return {
              output: [
                {
                  type: "function_call",
                  name: "list_dir",
                  call_id: `call-${responseSeq}`,
                  arguments: "{\"path\":\".\"}",
                },
              ],
            };
          },
          executeToolCall: async () => ({ code: "ok" }),
        },
      }),
      /tool loop exceeded max rounds \(2\)/
    );
    assert.equal(progressEvents.filter((event) => event.stage === "round_start").length, 2);
    assert.equal(progressEvents.some((event) => event.stage === "tool_loop_exceeded"), true);
  });
});

test("runCodexWithFileTools completes within max tool rounds", async () => {
  await withTempDir(async (root) => {
    const rootReal = await realpath(root);
    let responseSeq = 0;
    const progressEvents = [];
    const result = await hooks.runCodexWithFileTools({
      transcript: "complete-within-limit",
      messages: [],
      instructions: "",
      sessionId: "tool-round-ok-session",
      codexOptions: {
        modelInfo: {
          model: "openai-codex/gpt-5.4-mini",
          modelRef: "openai-codex/gpt-5.4-mini",
        },
        reasoningEffort: "low",
      },
      resolvedRoot: {
        rootReal,
        relativeRoot: ".",
      },
      onProgress: (event) => {
        progressEvents.push(event);
      },
      testHooks: {
        maxToolRounds: 2,
        createCodexResponse: async () => {
          responseSeq += 1;
          if (responseSeq === 1) {
            return {
              output: [
                {
                  type: "function_call",
                  name: "list_dir",
                  call_id: "call-1",
                  arguments: "{\"path\":\".\"}",
                },
              ],
            };
          }
          return {
            output_text: "final answer",
          };
        },
        executeToolCall: async () => ({ code: "ok" }),
      },
    });
    assert.equal(result.reply, "final answer");
    assert.equal(result.toolCalls, 1);
    assert.equal(progressEvents.some((event) => event.stage === "final_response_ready"), true);
    assert.equal(progressEvents.some((event) => event.stage === "tool_loop_exceeded"), false);
  });
});

test("session messages keep tool status logs for restore", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const llmRootCwd = path.join(process.cwd(), "llm_root");
  await hooks.appendAppConversationToCliRollout({
    sessionId,
    cwd: llmRootCwd,
    directory: "llm_root",
    userText: "ユーザー発話",
    statusLogs: ["tool : search_dir", "tool_error : search_dir (failed)"],
    assistantText: "最終返信",
  });
  const payload = await hooks.listLlmSessionMessages(sessionId, {
    source: "all",
    directory: "llm_root",
    limit: 40,
  });
  assert.equal(payload.found, true);
  const toolStart = payload.messages.find((item) => item.content === "tool : search_dir");
  assert.ok(toolStart);
  assert.equal(toolStart.kind, "status_log");
  const toolError = payload.messages.find((item) => item.content.startsWith("tool_error : search_dir"));
  assert.ok(toolError);
  assert.equal(toolError.kind, "status_log");
});
