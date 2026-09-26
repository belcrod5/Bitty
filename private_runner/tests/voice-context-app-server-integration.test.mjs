import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";

const enabled = process.env.RUN_VOICE_CODEX_MOCK_INTEGRATION === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function waitForPort(value, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated Codex App Server exited: ${child.exitCode}`);
    const ready = await new Promise((resolve) => {
      const socket = net.connect(value, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error("isolated Codex App Server did not listen");
}

for (const withGlobalMcp of [true, false]) test(
  withGlobalMcp ? "isolated Codex App Server sends voice context with inherited MCP" : "isolated Codex App Server sends selected voice context without global MCP",
  { skip: !enabled }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-codex-integration-"));
  execFileSync("git", ["init", "--quiet", "--template=", temp]);
  const ancestorInstruction = "VOICE_ANCESTOR_AGENTS_SENTINEL_DO_NOT_INCLUDE";
  await fs.writeFile(path.join(temp, "AGENTS.md"), ancestorInstruction);
  let resolveInput;
  let modelRequestCount = 0;
  const modelRequests = [];
  const modelInput = new Promise((resolve) => { resolveInput = resolve; });
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/v1/responses") {
      modelRequestCount++;
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      modelRequests.push(input);
      resolveInput(input);
      if (modelRequestCount === 3) {
        const item = {
          id: "msg_mock_summary", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "MOCK_SUMMARY" }],
        };
        const result = {
          id: "resp_mock_summary", object: "response", created_at: Math.floor(Date.now() / 1000),
          model: "gpt-6-luna", status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: result },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"isolated_mock_stopped"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const modelPort = mock.address().port;
  const appPort = await port();
  const codexHome = path.join(temp, "codex-home");
  await fs.mkdir(codexHome, { mode: 0o700 });
  if (withGlobalMcp) await fs.writeFile(path.join(codexHome, "config.toml"),
    '[mcp_servers.voice_probe]\ncommand = "/bin/false"\n', { mode: 0o600 });
  const codex = spawn("codex", [
    "app-server", "--listen", `ws://127.0.0.1:${appPort}`,
    "-c", 'model_provider="bitty_mock"',
    "-c", 'model="gpt-6-sol"',
    "-c", 'model_providers.bitty_mock.name="Bitty Mock"',
    "-c", `model_providers.bitty_mock.base_url="http://127.0.0.1:${modelPort}/v1"`,
    "-c", 'model_providers.bitty_mock.wire_api="responses"',
    "-c", "model_providers.bitty_mock.requires_openai_auth=false",
    "-c", "model_providers.bitty_mock.request_max_retries=0",
    "-c", "model_providers.bitty_mock.stream_max_retries=0",
  ], {
    cwd: temp,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: temp,
      CODEX_HOME: codexHome,
      TMPDIR: temp,
      NO_PROXY: "127.0.0.1,localhost",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let codexError = "";
  codex.stderr.on("data", (data) => { codexError = `${codexError}${data}`.slice(-4000); });
  t.after(async () => {
    codex.kill();
    if (codex.exitCode === null) await Promise.race([
      new Promise((resolve) => codex.once("exit", resolve)),
      delay(2000),
    ]);
    await fs.rm(temp, { recursive: true, force: true });
  });
  await waitForPort(appPort, codex);

  const rootDir = path.join(temp, "voice-data");
  const rpcErrors = [];
  const mcpPages = [];
  const createClient = () => {
    const client = createCodexAppServerClient({ upstreamUrl: `ws://127.0.0.1:${appPort}` });
    const request = client.request;
    client.request = async (method, params, timeout) => {
      try {
        const result = await request(method, params, timeout);
        if (method === "mcpServerStatus/list" && params.threadId) mcpPages.push(result.data);
        return result;
      } catch (error) { rpcErrors.push(`${method}: ${error.message}`); throw error; }
    };
    return client;
  };
  const probe = createClient();
  await probe.openPromise;
  await probe.request("initialize", {
    clientInfo: { name: "voice-mcp-probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  probe.notify("initialized", {});
  assert.equal((await probe.request("mcpServerStatus/list", {})).data.some(({ name }) => name === "voice_probe"), withGlobalMcp);
  probe.close();
  const initial = createVoiceContextService({ rootDir, createClient });
  const { logicalConversationId } = await initial.open();
  const directory = path.join(rootDir, logicalConversationId);
  const events = [];
  const at = new Date().toISOString();
  for (let pairSeq = 1; pairSeq <= 11; pairSeq++) {
    const clientOperationId = randomUUID();
    const user = pairSeq === 1 ? "OLD_ONLY_USER" : `RECENT_USER_${pairSeq}`;
    const assistant = pairSeq === 1 ? "OLD_ONLY_ASSISTANT" : `RECENT_ASSISTANT_${pairSeq}`;
    events.push({ seq: events.length + 1, at, clientOperationId, type: "accepted", text: user });
    events.push({ seq: events.length + 1, at, clientOperationId, type: "dispatching" });
    events.push({ seq: events.length + 1, at, clientOperationId, type: "native_started", threadId: randomUUID(), turnId: randomUUID() });
    events.push({ seq: events.length + 1, at, clientOperationId, type: "completed", pairSeq, text: assistant });
  }
  await fs.writeFile(path.join(directory, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(directory, "MEMORY.md"), "<!-- voice-context:v1 summarizedThroughPair=1 -->\nMEMORY_SUMMARY", { mode: 0o600 });

  const service = createVoiceContextService({ rootDir, createClient });
  const clientOperationId = randomUUID();
  const terminal = new Promise((resolve) => {
    void service.start({ operationId: clientOperationId, payload: {
      backendId: "codex", logicalConversationId, clientOperationId,
      input: { blocks: [{ type: "text", text: "CURRENT_USER" }] },
    } }, resolve, async () => "decline").catch(resolve);
  });
  const first = await within(Promise.race([
    modelInput.then((value) => ({ kind: "upstream", value })),
    terminal.then((value) => ({ kind: "terminal", value })),
  ]), 20000, "mock model did not receive an input");
  assert.equal(first.kind, "upstream", `voice stopped before mock input: ${JSON.stringify(first.value)} ${rpcErrors.join("; ")} ${codexError}`);
  assert.equal(mcpPages.length, 0);
  const upstream = first.value;
  assert.equal(JSON.stringify(upstream).includes(ancestorInstruction), false);
  assert.equal(upstream.model, "gpt-6-luna");
  const conversationItems = upstream.input.filter((item) =>
    ["MEMORY_SUMMARY", "RECENT_USER_", "RECENT_ASSISTANT_", "CURRENT_USER", "OLD_ONLY_"].some((part) =>
      JSON.stringify(item).includes(part)));
  assert.deepEqual(conversationItems.map((item) => [item.role, item.content?.[0]?.text]), [
    ["assistant", "Previous conversation summary:\nMEMORY_SUMMARY"],
    ...Array.from({ length: 10 }, (_, index) => index + 2).flatMap((number) => [
      ["user", `RECENT_USER_${number}`], ["assistant", `RECENT_ASSISTANT_${number}`],
    ]),
    ["user", "CURRENT_USER"],
  ]);
  assert.equal(JSON.stringify(upstream.input).includes("OLD_ONLY_"), false);
  assert.equal((await within(terminal, 20000, "voice turn did not settle")).status, "failed");

  // The earlier fixture intentionally has exactly ten unsummarized pairs. Reopen with
  // cursor zero to exercise the separate summary thread through the real App Server.
  await fs.writeFile(path.join(directory, "MEMORY.md"), "<!-- voice-context:v1 summarizedThroughPair=0 -->\n", { mode: 0o600 });
  const summaryService = createVoiceContextService({ rootDir, createClient });
  await summaryService.open();
  await within((async () => {
    while (modelRequests.length < 2) await delay(25);
  })(), 20000, `summary never reached the mock model: ${rpcErrors.join("; ")} ${codexError}`);
  assert.ok(mcpPages.length > 0);
  assert.ok(mcpPages.every((page) => page.every((server) => server.runtimeStatus === "disabled"
    && Object.keys(server.tools).length === 0 && server.resources.length === 0
    && server.resourceTemplates.length === 0)));
  assert.equal(mcpPages.some((page) => page.length > 0), withGlobalMcp);
  const summaryRequest = modelRequests[1];
  assert.equal(JSON.stringify(summaryRequest).includes(ancestorInstruction), false);
  assert.equal(summaryRequest.model, "gpt-6-luna");
  assert.equal(JSON.stringify(summaryRequest.input).includes("previousMemory"), false);
  assert.equal(JSON.stringify(summaryRequest.input).includes("MEMORY_SUMMARY"), false);
  assert.equal(JSON.stringify(summaryRequest.input).includes("OLD_ONLY_USER"), true);
  assert.equal(JSON.stringify(summaryRequest.input).includes("RECENT_USER_2"), false);
  const pending = JSON.parse(await fs.readFile(path.join(directory, "memory-pending.json"), "utf8"));
  assert.deepEqual([pending.fromPairSeq, pending.throughPairSeq], [1, 1]);
  assert.match(await fs.readFile(path.join(directory, "MEMORY.md"), "utf8"), /summarizedThroughPair=0/);
  await within((async () => {
    while (!(await fs.readFile(path.join(directory, "MEMORY.md"), "utf8")).includes("summarizedThroughPair=1")) await delay(25);
  })(), 20000, `summary retry did not commit: ${rpcErrors.join("; ")} ${codexError}`);
  assert.match(await fs.readFile(path.join(directory, "MEMORY.md"), "utf8"), /MOCK_SUMMARY/);
  assert.equal((await summaryService.open()).unsummarizedMessageCount, 20);
});
