import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { createSttCorrectionService } from "../src/stt-correction.mjs";

const enabled = process.env.RUN_STT_CODEX_MOCK_INTEGRATION === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

test("isolated app server accepts correction turn and receives only bounded transcript context",
  { skip: !enabled, timeout: 40000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-stt-correction-integration-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "AGENTS.md"), "ANCESTOR_AGENTS_SENTINEL");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, "config.toml"),
      '[mcp_servers.probe]\ncommand = "/bin/false"\n');
    const upstreamRequests = [];
    const upstream = createServer(async (request, response) => {
      if (request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const item = { id: "msg_correction", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: '{"changed":true,"text":"補正した文章"}' }] };
      const completed = { id: "resp_correction", object: "response", created_at: Math.floor(Date.now() / 1000),
        model: "gpt-6-luna", status: "completed", output: [item],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
      response.end();
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));
    const appPort = await freePort();
    const codex = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${appPort}`,
      "-c", 'model_provider="bitty_mock"', "-c", 'model="gpt-6-luna"',
      "-c", 'model_providers.bitty_mock.name="Bitty Mock"',
      "-c", `model_providers.bitty_mock.base_url="http://127.0.0.1:${upstream.address().port}/v1"`,
      "-c", 'model_providers.bitty_mock.wire_api="responses"',
      "-c", "model_providers.bitty_mock.requires_openai_auth=false",
      "-c", "model_providers.bitty_mock.request_max_retries=0",
      "-c", "model_providers.bitty_mock.stream_max_retries=0"], {
      cwd: root,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, CODEX_HOME: codexHome,
        TMPDIR: root, NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    codex.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    t.after(async () => {
      codex.kill();
      if (codex.exitCode === null) await Promise.race([new Promise((resolve) => codex.once("exit", resolve)), delay(2000)]);
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (codex.exitCode !== null) break;
      ready = await new Promise((resolve) => {
        const socket = net.connect(appPort, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, stderr);
    const service = createSttCorrectionService({
      createClient: () => createCodexAppServerClient({ upstreamUrl: `ws://127.0.0.1:${appPort}` }),
      settings: { getCorrection: async () => ({ model: "gpt-6-luna", effort: "low" }) },
      workspaceDirectory: path.join(root, "scratch"),
    });
    const result = await service.correct({ text: "元の文章", context: [{ role: "assistant", text: "直前の返答" }] });
    assert.deepEqual(result, { changed: true, text: "補正した文章" });
    assert.equal(upstreamRequests.length, 1);
    assert.deepEqual(upstreamRequests[0].tools ?? [], []);
    const sent = JSON.stringify(upstreamRequests[0]);
    assert.equal(sent.includes("ANCESTOR_AGENTS_SENTINEL"), false);
    assert.equal(sent.includes("直前の返答"), true);
    assert.equal(sent.includes("元の文章"), true);
    assert.equal(sent.includes("/bin/false"), false);
  });
