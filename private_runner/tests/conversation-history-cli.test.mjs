import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { sessionMarkdownLink } from "../bin/bitty-history";

const execFile = promisify(execFileCallback);
const CLI = path.resolve("private_runner/bin/bitty-history");

test("conversation history CLI emits a bounded Markdown deep link without changing the API domain", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-cli-"));
  const realTemp = await fs.realpath(temp);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const tokenFile = path.join(temp, "token");
  await fs.writeFile(tokenFile, "test-token\n", { mode: 0o600 });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      results: [{
        sessionRef: { backendId: "claude", nativeSessionId: "session-1" },
        canonicalCwd: "/work/日本語 project",
        sessionCreatedAt: "2026-08-22T00:00:00.000Z",
        messageId: "msg_1",
        role: "assistant",
        snippet: "[matching] answer",
        conversationCursor: "opaque-cursor",
      }],
      scanned: { sessions: 1, items: 10, pages: 1 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { stdout } = await execFile(CLI, [
    "search", "matching words", "--limit", "1", "--cwd", realTemp,
    "--order", "newest", "--since", "2026-08-22T00:00:00.000Z",
  ], {
    cwd: temp,
    env: {
      ...process.env,
      BITTY_RUNNER_TOKEN_FILE: tokenFile,
      BITTY_RUNNER_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].markdownLink,
    "[assistant: \\[matching\\] answer](bitty://session/claude/session-1?messageId=msg_1&cwd=%2Fwork%2F%E6%97%A5%E6%9C%AC%E8%AA%9E%20project)");
  assert.equal(payload.results[0].readCommand,
    "bitty-history read claude session-1 opaque-cursor");
  assert.equal(payload.results[0].sessionCreatedAt, "2026-08-22T00:00:00.000Z");
  assert.equal(requests[0].authorization, "Bearer test-token");
  const requested = new URL(requests[0].url, "http://runner.test");
  assert.equal(requested.pathname, "/agent/session-history/search");
  assert.equal(requested.searchParams.get("query"), "matching words");
  assert.equal(requested.searchParams.get("cwd"), realTemp);
  assert.equal(requested.searchParams.get("order"), "newest");
  assert.equal(requested.searchParams.get("since"), "2026-08-22T00:00:00.000Z");
});

test("conversation history CLI pages omitted approved workspaces without hiding partial coverage", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-workspaces-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const tokenFile = path.join(temp, "token");
  await fs.writeFile(tokenFile, "test-token\n", { mode: 0o600 });
  const requestedUrls = [];
  const workspaces = Array.from({ length: 10 }, (_, index) => ({ canonicalRoot: `/work/${index}` }));
  const server = http.createServer((request, response) => {
    requestedUrls.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url.startsWith("/agent/workspaces")
      ? { workspaces }
      : { results: [], scanned: { sessions: 0, items: 0, pages: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    ...process.env,
    BITTY_RUNNER_TOKEN_FILE: tokenFile,
    BITTY_RUNNER_URL: `http://127.0.0.1:${address.port}`,
  };
  const first = await execFile(CLI, ["search", "needle"], {
    env: {
      ...environment,
    },
  });
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.partial, true);
  assert.deepEqual(firstPayload.workspaceSearch, {
    offset: 0,
    searchedCount: 8,
    totalCount: 10,
    partial: true,
    nextOffset: 8,
    instruction: "Finish the current result cursor first, then repeat the search with --workspace-offset 8 and without --cursor.",
  });
  assert.equal(requestedUrls.length, 2);
  const searchUrl = new URL(requestedUrls[1], "http://runner.test");
  assert.deepEqual(searchUrl.searchParams.getAll("cwd"), workspaces.slice(0, 8).map((entry) => entry.canonicalRoot));

  const second = await execFile(CLI, ["search", "needle", "--workspace-offset", "8"], { env: environment });
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.partial, undefined);
  assert.deepEqual(secondPayload.workspaceSearch, {
    offset: 8,
    searchedCount: 2,
    totalCount: 10,
  });
  const secondSearchUrl = new URL(requestedUrls[3], "http://runner.test");
  assert.deepEqual(secondSearchUrl.searchParams.getAll("cwd"), workspaces.slice(8).map((entry) => entry.canonicalRoot));
});

test("conversation history CLI honors the documented runner token file relative to the repository", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-history-runner-token-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const tokenFile = path.join(temp, "token");
  await fs.writeFile(tokenFile, "documented-token\n", { mode: 0o600 });
  let authorization = "";
  const server = http.createServer((request, response) => {
    authorization = String(request.headers.authorization || "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [], scanned: {} }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await execFile(CLI, ["search", "needle", "--cwd", temp], {
    cwd: temp,
    env: {
      ...process.env,
      BITTY_RUNNER_TOKEN_FILE: "",
      RUNNER_TOKEN_FILE: path.relative(path.resolve("."), tokenFile),
      BITTY_RUNNER_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  assert.equal(authorization, "Bearer documented-token");
});

test("session Markdown link requires the admitted canonical cwd", () => {
  assert.equal(sessionMarkdownLink({
    sessionRef: { backendId: "codex", nativeSessionId: "session-1" },
    messageId: "msg_1",
    role: "user",
    snippet: "match",
  }), "");
});
