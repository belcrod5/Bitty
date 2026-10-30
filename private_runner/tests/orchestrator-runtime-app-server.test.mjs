import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorRuntime } from "../src/orchestrator-runtime.mjs";
import { prepareOrchestratorRuntime, assertOrchestratorRuntime } from "../src/orchestrator-runtime-profile.mjs";

const enabled = process.env.RUN_ORCHESTRATOR_RUNTIME_CODEX_INTEGRATION === "1";
const OTHER = "12345678-1234-4234-8234-123456789abc";

async function initialize(client) {
  await client.openPromise;
  const result = await client.request("initialize", { clientInfo: { name: "bitty-owner-integration", version: "0.1.0" },
    capabilities: { experimentalApi: true } }, 10_000);
  client.notify("initialized", {});
  return result;
}

// Uses only a localhost fake provider and disposable homes. No real credentials or model requests.
test("real App Servers isolate prompt, file access and durable sessions across owners and restart", { skip: !enabled, timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-server-test-"));
  const requests = [], shellProbes = new Map(), probeOutputs = new Map(), approvals = [];
  const issuedProbes = new Set();
  let manager;
  let taskPid;
  let taskRunning = false;
  const mock = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404); response.end(); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(input);
    const latestUser = input.input.filter((item) => item.role === "user").at(-1)?.content?.[0]?.text;
    const probe = shellProbes.get(latestUser);
    const issueProbe = probe && !issuedProbes.has(latestUser);
    if (issueProbe) issuedProbes.add(latestUser);
    else if (probe) probeOutputs.set(latestUser, JSON.stringify(input.input.filter((item) => item.type?.endsWith("_output"))));
    const item = issueProbe ? { id: `fc_${requests.length}`, type: "custom_tool_call", namespace: "functions",
      name: "exec", call_id: `call_${requests.length}`, status: "completed",
      input: `text(await tools.exec_command(${JSON.stringify(probe)}));` } : { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "OWNED_MOCK_REPLY" }] };
    const result = { id: `resp_${requests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000),
      model: "gpt-6-sol", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (taskRunning) { try { process.kill(taskPid, "SIGKILL"); } catch {} }
    await manager?.shutdown();
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const globalHome = path.join(root, "shared-home");
  await fs.mkdir(path.join(globalHome, ".codex", "skills", "global"), { recursive: true });
  await fs.writeFile(path.join(globalHome, ".codex", "skills", "global", "SKILL.md"),
    "---\nname: global\ndescription: GLOBAL_SKILL_SENTINEL\n---\nGlobal body\n");
  await fs.mkdir(path.join(root, ".codex"));
  await fs.writeFile(path.join(root, ".codex", "config.toml"), 'developer_instructions="GLOBAL_CONFIG_SENTINEL"\n');
  await fs.writeFile(path.join(root, "AGENTS.md"), "ANCESTOR_INSTRUCTION_SENTINEL");
  const aWorkspace = path.join(root, "workspace"), bWorkspace = path.join(root, "orchestrators", OTHER, "workspace");
  for (const workspace of [aWorkspace, bWorkspace]) {
    await fs.mkdir(path.join(workspace, ".agents", "skills", "expert"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".agents", "skills", "expert", "SKILL.md"),
      `---\nname: expert\ndescription: ${workspace === aWorkspace ? "OWNER_A_SKILL" : "OWNER_B_SKILL"}\n---\nOwned expertise\n`);
    const codexHome = path.join(path.dirname(workspace), "runtime-home", "codex");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      'model_provider="owned_mock"', 'model="gpt-6-sol"',
      ...(workspace === aWorkspace ? ['default_permissions="owned"'] : []),
      '[model_providers.owned_mock]', 'name="Owned Mock"', `base_url="http://127.0.0.1:${mock.address().port}/v1"`,
      'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0',
      ...(workspace === aWorkspace ? ['[permissions.owned.filesystem]', '":minimal"="read"', '":workspace_roots"="write"',
        '[permissions.owned.network]', 'enabled=false'] : []),
    ].join("\n"));
  }
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "mock-account", chatgpt_plan_type: "plus" } })).toString("base64url")}.mock`;
  const supervisors = [];
  manager = createOrchestratorRuntime({ rootDir: root,
    spawnImpl(...args) { const child = spawn(...args); supervisors.push({ child, env: args[2].env }); return child; },
    childEnv: { PATH: process.env.PATH, HOME: globalHome,
    CODEX_HOME: path.join(globalHome, ".codex"), OPENAI_API_KEY: "DO_NOT_INHERIT" },
  resolveAuth: async () => ({ accessToken: token, accountId: "mock-account" }) });
  const options = (id, workspaceDirectory) => ({ orchestratorId: id, workspaceDirectory, turnCompletionTimeoutMs: 10_000 });
  const a = await manager.createClient(options("main", aWorkspace));
  const aInfo = await initialize(a);
  let b = await manager.createClient(options(OTHER, bWorkspace));
  const bInfo = await initialize(b);
  assert.notEqual(aInfo.codexHome, bInfo.codexHome);
  assert.equal(await fs.stat(path.join(aInfo.codexHome, "auth.json")).then(() => true, () => false), false);
  // The second home matches production: no preconfigured permissions/default profile.
  const bProfile = await prepareOrchestratorRuntime(b, { workspaceDirectory: bWorkspace, cwd: bWorkspace });
  const bThread = await b.request("thread/start", { cwd: await fs.realpath(bWorkspace), ...bProfile,
    ephemeral: false, approvalPolicy: "never", model: "gpt-6-sol" }, 10_000);
  assertOrchestratorRuntime(bThread, bProfile);
  assert.deepEqual(await b.request("mcpServerStatus/list", { threadId: bThread.thread.id, cursor: null }, 10_000), { data: [], nextCursor: null });
  const bReadOnly = await prepareOrchestratorRuntime(b, { workspaceDirectory: bWorkspace, cwd: bWorkspace, readOnly: true });
  // Simulate an old persisted parent: the next resume must apply the new policy in place.
  const preflight = await b.request("thread/start", { cwd: await fs.realpath(bWorkspace), ...bReadOnly,
    ephemeral: false, approvalPolicy: "on-request", model: "gpt-6-sol" }, 10_000);
  assert.equal(preflight.approvalPolicy, "on-request");
  assert.deepEqual(await b.request("mcpServerStatus/list", { threadId: preflight.thread.id, cursor: null }, 10_000), { data: [], nextCursor: null });
  const bCompletion = b.waitForTurnCompletion();
  const bTurn = await b.request("turn/start", { threadId: preflight.thread.id, input: [{ type: "text", text: "OWNER_B_READ_ONLY_INPUT" }] }, 10_000);
  bCompletion.expect({ threadId: preflight.thread.id, turnId: bTurn.turn.id });
  await bCompletion.promise;
  b.close();
  b = await manager.createClient(options(OTHER, bWorkspace));
  await initialize(b);
  const bResumed = await b.request("thread/resume", { threadId: preflight.thread.id, cwd: await fs.realpath(bWorkspace), ...bProfile,
    approvalPolicy: "never", model: "gpt-6-sol" }, 10_000);
  assertOrchestratorRuntime(bResumed, bProfile);
  assert.equal(bResumed.thread.id, preflight.thread.id);
  assert.deepEqual(await b.request("mcpServerStatus/list", { threadId: bResumed.thread.id, cursor: null }, 10_000), { data: [], nextCursor: null });
  const bReplyCompletion = b.waitForTurnCompletion();
  const bReply = await b.request("turn/start", { threadId: bResumed.thread.id, input: [{ type: "text", text: "OWNER_B_CURRENT_INPUT" }] }, 10_000);
  bReplyCompletion.expect({ threadId: bResumed.thread.id, turnId: bReply.turn.id });
  await bReplyCompletion.promise;
  const bHistory = await b.request("thread/read", { threadId: bResumed.thread.id, includeTurns: true }, 10_000);
  assert.equal(bHistory.thread.turns.at(-1).status, "completed");
  const runtime = await prepareOrchestratorRuntime(a, { workspaceDirectory: aWorkspace, cwd: aWorkspace });
  const started = await a.request("thread/start", { cwd: await fs.realpath(aWorkspace), ...runtime,
    ephemeral: false, approvalPolicy: "never", developerInstructions: "OWNER_A_ONLY", model: "gpt-6-sol" }, 10_000);
  assertOrchestratorRuntime(started, runtime);
  const threadId = started.thread.id;
  assert.deepEqual(await a.request("mcpServerStatus/list", { threadId, cursor: null }, 10_000), { data: [], nextCursor: null });
  const completion = a.waitForTurnCompletion();
  const turn = await a.request("turn/start", { threadId, input: [{ type: "text", text: "OWNER_A_CURRENT_INPUT" }] }, 10_000);
  completion.expect({ threadId, turnId: turn.turn.id });
  await completion.promise;
  assert.equal(requests.length, 3);
  const prompt = JSON.stringify(requests[2]);
  assert.equal(prompt.includes("OWNER_A_SKILL"), true);
  for (const sentinel of ["OWNER_B_SKILL", "GLOBAL_SKILL_SENTINEL", "GLOBAL_CONFIG_SENTINEL", "ANCESTOR_INSTRUCTION_SENTINEL", "DO_NOT_INHERIT"]) {
    assert.equal(prompt.includes(sentinel), false, sentinel);
  }
  const summaryRuntime = await prepareOrchestratorRuntime(a, { workspaceDirectory: aWorkspace, cwd: aWorkspace, readOnly: true });
  const summary = await a.request("thread/start", { cwd: await fs.realpath(aWorkspace), ...summaryRuntime,
    ephemeral: true, approvalPolicy: "never", model: "gpt-6-sol" }, 10_000);
  assertOrchestratorRuntime(summary, summaryRuntime);
  assert.deepEqual(await a.request("mcpServerStatus/list", { threadId: summary.thread.id, cursor: null }, 10_000), { data: [], nextCursor: null });
  await assert.rejects(b.request("thread/read", { threadId, includeTurns: true }, 10_000));
  a.addServerRequestHandler((request) => {
    if (request.method.endsWith("requestApproval")) { approvals.push(request); return { decision: "decline" }; }
    return undefined;
  });
  const inside = path.join(aWorkspace, "inside-marker"), outside = path.join(bWorkspace, "outside-marker");
  await fs.writeFile(inside, "INSIDE_ALLOWED"); await fs.writeFile(outside, "OUTSIDE_SECRET");
  shellProbes.set("SHELL_PROBE_LOCAL", { cmd: "/bin/cat inside-marker", workdir: aWorkspace });
  shellProbes.set("SHELL_PROBE_EXTERNAL", { cmd: `/bin/cat ${outside}`, workdir: aWorkspace,
    sandbox_permissions: "require_escalated", justification: "Read a marker outside the owned workspace" });
  for (const input of shellProbes.keys()) {
    const completed = a.waitForTurnCompletion();
    const probe = await a.request("turn/start", { threadId, input: [{ type: "text", text: input }], approvalPolicy: "never" }, 10_000);
    completed.expect({ threadId, turnId: probe.turn.id }); await completed.promise;
  }
  assert.equal(approvals.length, 0, "isolated shell escalation must fail without requesting user approval");
  assert.match(probeOutputs.get("SHELL_PROBE_LOCAL") || "", /INSIDE_ALLOWED/);
  assert.match(probeOutputs.get("SHELL_PROBE_EXTERNAL") || "", /(?:never|escalat|reject|not allowed)/i);
  assert.doesNotMatch(probeOutputs.get("SHELL_PROBE_EXTERNAL") || "", /OUTSIDE_SECRET/);
  const allowed = await a.request("command/exec", { command: ["/bin/cat", inside], cwd: aWorkspace, permissionProfile: "owned" }, 10_000);
  assert.equal(allowed.exitCode, 0); assert.equal(allowed.stdout, "INSIDE_ALLOWED");
  const denied = await a.request("command/exec", { command: ["/bin/cat", outside], cwd: aWorkspace, permissionProfile: "owned" }, 10_000);
  assert.notEqual(denied.exitCode, 0); assert.equal(denied.stdout.includes("OUTSIDE_SECRET"), false);
  const runtimeMarker = path.join(aInfo.codexHome, "private-marker");
  await fs.writeFile(runtimeMarker, "RUNTIME_PRIVATE");
  const hiddenHome = await a.request("command/exec", { command: ["/bin/cat", runtimeMarker], cwd: aWorkspace, permissionProfile: "owned" }, 10_000);
  assert.notEqual(hiddenHome.exitCode, 0); assert.equal(hiddenHome.stdout.includes("RUNTIME_PRIVATE"), false);
  const pidFile = path.join(aWorkspace, "task.pid");
  const running = a.request("command/exec", { command: ["/bin/sh", "-c", 'printf "%s" "$$" > "$1"; exec /bin/sleep 60', "owned", pidFile],
    cwd: aWorkspace, permissionProfile: "owned", timeoutMs: 60_000 }, 10_000).catch((error) => error);
  for (let attempt = 0; attempt < 100 && !taskPid; attempt++) {
    taskPid = await fs.readFile(pidFile, "utf8").then(Number, () => 0);
    if (!taskPid) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(taskPid);
  taskRunning = true;
  supervisors.find((entry) => entry.env.CODEX_HOME === aInfo.codexHome).child.disconnect();
  await running;
  let gone = false;
  for (let attempt = 0; attempt < 100 && !gone; attempt++) {
    try { process.kill(taskPid, 0); } catch (error) { gone = error.code === "ESRCH"; }
    if (!gone) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(gone, true, "IPC loss must stop a real Codex command subprocess");
  taskRunning = false;
  const restarted = await manager.createClient(options("main", aWorkspace));
  await initialize(restarted);
  const nextRuntime = await prepareOrchestratorRuntime(restarted, { workspaceDirectory: aWorkspace, cwd: aWorkspace });
  const resumed = await restarted.request("thread/resume", { threadId, cwd: await fs.realpath(aWorkspace), ...nextRuntime,
    approvalPolicy: "never", developerInstructions: "OWNER_A_ONLY", model: "gpt-6-sol" }, 10_000);
  assertOrchestratorRuntime(resumed, nextRuntime);
  assert.equal(resumed.thread.id, threadId);
  restarted.close(); b.close();
});
