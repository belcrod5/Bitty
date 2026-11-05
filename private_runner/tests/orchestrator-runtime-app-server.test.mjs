import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { startCodexTurn } from "../src/codex-turn-execution.mjs";
import { createVoiceOrchestratorService } from "../src/voice-orchestrator-service.mjs";

const enabled = process.env.RUN_ORCHESTRATOR_RUNTIME_CODEX_INTEGRATION === "1";

// One disposable shared App Server, fake HOME/credentials/CLI/MCP and localhost
// provider. This exercises the same client and approval path as ordinary chats.
test("orchestration and native children inherit normal tools, environment and approvals", { skip: !enabled, timeout: 45_000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-shared-test-"));
  const home = path.join(temp, "home"), codexHome = path.join(home, ".codex"), bin = path.join(temp, "bin");
  const xdg = path.join(temp, "config"), tmp = path.join(temp, "tmp");
  for (const dir of [codexHome, bin, xdg, tmp]) await fs.mkdir(dir, { recursive: true });
  const sharedFile = path.join(home, "shared-fixture"), approvedFile = path.join(home, "approved-writes");
  await fs.writeFile(sharedFile, "SHARED_FILE_SENTINEL");
  await fs.writeFile(path.join(bin, "fixture-cli"), '#!/bin/sh\nprintf "SHARED_CLI:%s:%s:%s" "$BITTY_FIXTURE_SECRET" "$HOME" "$XDG_CONFIG_HOME"\n', { mode: 0o700 });
  const skill = path.join(codexHome, "skills", "fixture"); await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: fixture\ndescription: SHARED_SKILL_SENTINEL\n---\nUse the disposable fixture CLI.\n");
  const mcp = path.join(temp, "fixture-mcp.mjs");
  await fs.writeFile(mcp, `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (request.id === undefined) continue;
  const result = request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list" ? { tools: [{ name: "echo", description: "Disposable shared tool", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: {} } }] }
    : request.method === "tools/call" ? { content: [{ type: "text", text: "SHARED_MCP_SENTINEL" }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}`);
  const requests = [], outputs = new Map(), issued = new Set(), approvals = [], calls = [], serverRequests = [];
  let phase = 0, childCompleted = false, networkRequests = 0, app, service, nextClient = 0;
  const command = `fixture-cli\n/bin/cat ${sharedFile}\n/usr/bin/curl -fsS http://127.0.0.1:PORT/network`;
  const mock = createServer(async (request, response) => {
    if (request.url === "/network") { networkRequests++; response.end("SHARED_NETWORK_SENTINEL"); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push(input);
    const latest = input.input.filter((item) => item.role === "user").at(-1)?.content?.[0]?.text || "";
    const child = input.input.some((item) => item.type === "agent_message" && item.recipient === "/root/environment_probe");
    const key = child ? "CHILD" : latest;
    const preflight = latest.startsWith("Call task_checklist.read_task_checklist");
    let item;
    if (latest === "ORCHESTRATOR_PROBE" && !childCompleted) {
      const name = phase === 0 ? "spawn_agent" : "wait_agent";
      const args = phase === 0 ? { task_name: "environment_probe", fork_turns: "none", message: "Use the shared environment fixture" } : { timeout_ms: 10000 };
      phase++;
      item = { type: "function_call", namespace: "collaboration", name, arguments: JSON.stringify(args) };
    } else if (preflight && !input.input.some((item) => item.type === "custom_tool_call_output")
      || !preflight && ["CHILD", "NORMAL_PROBE", "SPECIALIST_PROBE"].includes(key) && !issued.has(key)) {
      issued.add(key);
      const code = preflight ? "text(await tools.task_checklist__read_task_checklist({}));"
        : `text(await tools.exec_command(${JSON.stringify({ cmd: command.replace("PORT", mock.address().port) })}));\ntext(await tools.mcp__fixture__echo({}));\ntext(await tools.exec_command(${JSON.stringify({ cmd: `/usr/bin/printf 'APPROVED\\n' >> ${approvedFile}`, sandbox_permissions: "require_escalated", justification: "Write a disposable fixture outside the workspace" })}));`;
      item = { type: "custom_tool_call", namespace: "functions", name: "exec", input: code };
    } else {
      if (key === "CHILD") childCompleted = true;
      outputs.set(key, JSON.stringify(input.input.filter((item) => item.type?.endsWith("_output"))));
      const developer = JSON.stringify(input.input.filter((item) => item.role === "developer"));
      const text = developer.includes("Classify topic continuity") ? '{"decision":"continue","reason":"same task"}'
        : developer.includes("Update stored voice memory") ? '{"index":"# Topics\\n","topics":[]}' : "SHARED_REPLY";
      item = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
    }
    item = { id: `item_${requests.length}`, call_id: `call_${requests.length}`, status: "completed", ...item };
    const result = { id: `resp_${requests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), model: "gpt-6-sol", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const socket = path.join(temp, "rpc.sock"), url = `ws+unix://${socket}:/`;
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    'model_provider="fixture"', 'model="gpt-6-sol"', 'sandbox_mode="workspace-write"', 'approval_policy="on-request"', 'approvals_reviewer="user"',
    '[sandbox_workspace_write]', 'network_access=true', '[shell_environment_policy]', 'inherit="all"',
    '[model_providers.fixture]', 'name="Fixture"', `base_url="http://127.0.0.1:${mock.address().port}/v1"`,
    'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0',
    '[mcp_servers.fixture]', `command=${JSON.stringify(process.execPath)}`, `args=[${JSON.stringify(mcp)}]`,
  ].join("\n"));
  app = spawn("codex", ["app-server", "--listen", `unix://${socket}`], {
    cwd: temp, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdg,
      TMPDIR: tmp, BITTY_FIXTURE_SECRET: "FAKE_SHARED_CREDENTIAL", NO_PROXY: "127.0.0.1,localhost" }, stdio: "ignore" });
  t.after(async () => {
    await service?.close(); app.kill();
    if (app.exitCode === null) await new Promise((resolve) => app.once("exit", resolve));
    mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !await fs.stat(socket).then(() => true, () => false); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const createClient = () => {
    const client = createCodexAppServerClient({ upstreamUrl: url, turnCompletionTimeoutMs: 20_000 });
    const connection = ++nextClient, attachedThreads = [];
    const request = client.request, addHandler = client.addServerRequestHandler;
    client.addServerRequestHandler = (handler) => addHandler((request) => { serverRequests.push({ connection, attachedThreads: [...attachedThreads], ...request }); return handler(request); });
    client.request = (method, params, timeout) => { calls.push({ method, params }); return request(method, params, timeout).then((result) => { if (["thread/start", "thread/resume"].includes(method)) attachedThreads.push(result.thread.id); return result; }); };
    return client;
  };
  service = createVoiceOrchestratorService({ rootDir: path.join(temp, "data"), createClient });
  const opened = await service.open("main"), specialist = await service.create("Specialist");
  const specialistChat = await service.open(specialist.id);
  const turn = (orchestratorId, conversation, text) => new Promise((resolve, reject) => {
    const operationId = randomUUID();
    void service.start({ operationId, payload: { orchestratorId, backendId: "codex", logicalConversationId: conversation.logicalConversationId,
      clientOperationId: operationId, input: { blocks: [{ type: "text", text }] } } }, resolve,
    async (request) => { approvals.push({ owner: orchestratorId, ...request }); return "accept"; }).catch(reject);
  });
  const normal = createClient(), normalCompletion = normal.waitForTurnCompletion();
  let normalThread;
  normal.addServerRequestHandler((request) => {
    if (request.params?.threadId === normalThread && request.method.endsWith("requestApproval")) { approvals.push({ owner: "normal", ...request }); return { decision: "accept" }; }
  });
  const normalStarted = await startCodexTurn({ client: normal, clientName: "normal-fixture", cwd: temp,
    inputText: "NORMAL_PROBE", model: "gpt-6-sol", onThreadResolved: ({ threadId }) => { normalThread = threadId; } });
  normalCompletion.expect(normalStarted);
  const result = await turn("main", opened, "ORCHESTRATOR_PROBE");
  assert.equal(result.status, "completed", JSON.stringify(result));
  await normalCompletion.promise; normal.close();
  const specialistResult = await turn(specialist.id, specialistChat, "SPECIALIST_PROBE");
  assert.equal(specialistResult.status, "completed", JSON.stringify(specialistResult));
  assert.ok(phase >= 2);
  for (const key of ["NORMAL_PROBE", "CHILD", "SPECIALIST_PROBE"]) {
    assert.match(outputs.get(key) || "", /SHARED_CLI:FAKE_SHARED_CREDENTIAL/);
    assert.match(outputs.get(key) || "", /SHARED_FILE_SENTINEL/);
    assert.match(outputs.get(key) || "", /SHARED_NETWORK_SENTINEL/);
    assert.match(outputs.get(key) || "", /SHARED_MCP_SENTINEL/, JSON.stringify(serverRequests));
  }
  assert.equal(networkRequests, 3);
  assert.equal((await fs.readFile(approvedFile, "utf8")).trim().split("\n").length, 3);
  assert.equal(approvals.length, 3, "normal, native child and specialist use the same approval flow");
  assert.equal(approvals.filter((item) => item.owner === "normal").length, 1, JSON.stringify(serverRequests));
  assert.equal(approvals.filter((item) => item.owner === "main" && item.threadId !== normalThread).length, 1);
  const interactive = calls.filter(({ method, params }) => ["thread/start", "thread/resume"].includes(method) && params.approvalPolicy === "on-request");
  assert.ok(interactive.every(({ params }) => !params.sandbox && !params.permissions && !params.config.features && !params.config.shell_environment_policy));
  const childInput = requests.find(({ input }) => input.some((item) => item.type === "agent_message" && item.recipient === "/root/environment_probe"));
  assert.match(JSON.stringify(childInput), /SHARED_SKILL_SENTINEL/);
  const helpers = calls.filter(({ method, params }) => method === "thread/start" && params.ephemeral);
  assert.ok(helpers.every(({ params }) => params.config.features.shell_tool === false && params.config.agents.enabled === false));
  assert.ok(calls.some(({ method, params }) => method === "thread/inject_items" && JSON.stringify(params.items).includes("Task checklist read before this response")));
});
