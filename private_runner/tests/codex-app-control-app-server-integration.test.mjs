import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { APP_CONTROL_UNAVAILABLE_INSTRUCTION, startCodexTurn } from "../src/codex-turn-execution.mjs";

const enabled = process.env.RUN_APP_CONTROL_CODEX_MOCK_INTEGRATION === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

test("isolated loaded Codex thread receives current control reference and explicit clearing at model boundary",
  { skip: !enabled, timeout: 40000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-app-control-provider-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    const modelRequests = [];
    const provider = createServer(async (request, response) => {
      if (request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const item = { id: `msg_${modelRequests.length}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "MOCK_REPLY" }] };
      const completed = { id: `response_${modelRequests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000),
        model: "gpt-6-luna", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
      response.end();
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => { provider.closeAllConnections(); return new Promise((resolve) => provider.close(resolve)); });
    const appPort = await freePort();
    const child = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${appPort}`,
      "-c", 'model_provider="bitty_mock"', "-c", 'model="gpt-6-luna"',
      "-c", 'model_providers.bitty_mock.name="Bitty Mock"',
      "-c", `model_providers.bitty_mock.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
      "-c", 'model_providers.bitty_mock.wire_api="responses"',
      "-c", "model_providers.bitty_mock.requires_openai_auth=false",
      "-c", "model_providers.bitty_mock.request_max_retries=0",
      "-c", "model_providers.bitty_mock.stream_max_retries=0",
      "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"], {
      cwd: root,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, CODEX_HOME: codexHome,
        TMPDIR: root, NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    t.after(async () => {
      child.kill();
      if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated Codex exited before listening");
      ready = await new Promise((resolve) => {
        const socket = net.connect(appPort, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (!ready) await delay(100);
    }
    assert.equal(ready, true, "isolated Codex must listen");
    const client = createCodexAppServerClient({ upstreamUrl: `ws://127.0.0.1:${appPort}`, turnCompletionTimeoutMs: 20000 });
    t.after(() => client.close());
    await client.openPromise;
    await client.request("initialize", { clientInfo: { name: "bitty-control-test", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const { thread } = await client.request("thread/start", { cwd: root, ephemeral: false,
      approvalPolicy: "never", developerInstructions: "STABLE_THREAD_INSTRUCTION" });
    const seedCompletion = client.waitForTurnCompletion();
    const seed = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "SEED_EXISTING_THREAD" }] });
    seedCompletion.expect({ threadId: thread.id, turnId: seed.turn.id });
    await seedCompletion.promise;
    for (const value of ["CONTROL_REFERENCE_A", "CONTROL_REFERENCE_B", ""]) {
      const turnClient = createCodexAppServerClient({ upstreamUrl: `ws://127.0.0.1:${appPort}`, turnCompletionTimeoutMs: 20000 });
      t.after(() => turnClient.close());
      const completion = turnClient.waitForTurnCompletion();
      const identity = await startCodexTurn({ client: turnClient, clientName: "bitty-control-test", threadId: thread.id,
        cwd: root, approvalPolicy: "never", developerInstructions: "IGNORED_LOADED_THREAD_OVERRIDE",
        input: { blocks: [{ type: "text", text: "MOCK_USER_INPUT" }] }, trustedInstructions: value });
      completion.expect(identity);
      await completion.promise;
      turnClient.close();
    }
    assert.equal(modelRequests.length, 4);
    const controlRequests = modelRequests.slice(1);
    const latestContext = (request) => request.input.filter((item) => item.role === "developer"
      && JSON.stringify(item).includes("<bitty.appControl>")).at(-1);
    for (const [index, value] of ["CONTROL_REFERENCE_A", "CONTROL_REFERENCE_B", APP_CONTROL_UNAVAILABLE_INSTRUCTION].entries()) {
      const request = controlRequests[index];
      const context = latestContext(request);
      assert.equal(context.content[0].text, `<bitty.appControl>${value}</bitty.appControl>`);
      assert.equal(request.input.at(-2), context, "latest application context immediately precedes current user input");
      assert.equal(request.input.at(-1).role, "user");
      assert.equal(request.input.at(-1).content[0].text, "MOCK_USER_INPUT");
    }
    // Prior application fragments remain in provider history; authorization expires in Bitty.
    // The active fragment is the newest one, including an explicit unavailable value.
    assert.equal(JSON.stringify(controlRequests[2]).includes("CONTROL_REFERENCE_A"), true);
    assert.equal(JSON.stringify(controlRequests[2]).includes("CONTROL_REFERENCE_B"), true);
    assert.equal(modelRequests.every((request) => !JSON.stringify(request).includes("IGNORED_LOADED_THREAD_OVERRIDE")), true,
      "loaded thread resume ignores developer override");
    assert.equal(modelRequests.every((request) => request.input.some((item) => item.role === "developer"
      && JSON.stringify(item).includes("STABLE_THREAD_INSTRUCTION"))), true, "stable instructions remain");
  });
