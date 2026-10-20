#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Only infer a repository from the actual working tree, never an installed skill's layout.
async function findRepoRoot() {
  if (process.env.BITTY_REPO_ROOT) return path.resolve(process.env.BITTY_REPO_ROOT);
  for (let dir = process.cwd();; dir = path.dirname(dir)) {
    if (await fs.stat(path.join(dir, "private_runner/src/server-runtime.mjs")).then(s => s.isFile(), () => false)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}
const repoRoot = await findRepoRoot();
let baseUrl;
function runnerOrigin() {
  const url = new URL(process.env.BITTY_RUNNER_URL || "http://127.0.0.1:8788");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !["http:", "https:"].includes(url.protocol)
    || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("BITTY_RUNNER_URL must be an HTTPS origin or a local loopback HTTP origin");
  }
  return url;
}
const configuredTokenFile = process.env.BITTY_RUNNER_TOKEN_FILE || process.env.RUNNER_TOKEN_FILE;
const tokenFile = configuredTokenFile && path.isAbsolute(configuredTokenFile) ? configuredTokenFile
  : repoRoot ? path.resolve(repoRoot, configuredTokenFile || "private_runner/logs/runner-token") : null;
const usage = `Usage:
  bitty-session.mjs orchestrators
  bitty-session.mjs control status --context <context>
  bitty-session.mjs control stop --context <context>
  bitty-session.mjs control handoff --context <context> < target.json
  bitty-session.mjs control result --operation <epoch.UUID>
  bitty-session.mjs workspaces
  bitty-session.mjs sessions --cwd <path> [--backend <id|all>] [--cursor <cursor>]
  bitty-session.mjs board
  bitty-session.mjs board-apply < board-ops.json
  bitty-session.mjs board-remove --session <id> [--backend <id>] [--cwd <path>]
  bitty-session.mjs models --backend <id>
  bitty-session.mjs new --backend <id> --cwd <path> [--model <id>] [--effort <id>] [--wait] < message.txt
  bitty-session.mjs send --backend <id> --session <id> [--model <id>] [--effort <id>] [--wait] < message.txt
  bitty-session.mjs wait --run <runId>
  bitty-session.mjs respond --run <runId> --request <requestId> --decision <allow|allow_for_session|deny>
  bitty-session.mjs handoff --backend <id> --session <id>`;

function options(args) {
  const result = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === "--wait" && !result[flag]) {
      result[flag] = true;
      continue;
    }
    const value = args.shift();
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || result[flag]) {
      throw new Error(usage);
    }
    result[flag] = value;
  }
  return result;
}

function required(opts, flag) {
  const value = String(opts[flag] || "").trim();
  if (!value) throw new Error(`${flag} is required\n${usage}`);
  return value;
}

function assertOptions(opts, allowed) {
  for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw new Error(usage);
}

async function auth() {
  if (!tokenFile) throw new Error("Set BITTY_REPO_ROOT or an absolute BITTY_RUNNER_TOKEN_FILE");
  const stat = await fs.lstat(tokenFile);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Runner token file must be a regular file with mode 600: ${tokenFile}`);
  }
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error("Runner token file is empty");
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("Runner token has invalid bearer syntax");
  return token;
}

async function http(token, pathname, params, init = {}, timeout = 30_000) {
  const url = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`,
      ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(body.status || body.error?.message || body.message || body.error || `HTTP ${response.status}`));
    error.result = body;
    throw error;
  }
  return body;
}

async function interactiveProfile(token, backendId) {
  const status = await http(token, "/agent/backends/status");
  const backend = (status.backends || []).find((entry) => entry.backendId === backendId);
  if (!backend) throw new Error(`Backend is unavailable: ${backendId}`);
  return backend.capabilities?.action?.policyProfiles?.find((profile) => profile.interactive === true)?.id || "";
}

async function readInput(limit = 1024 * 1024) {
  if (process.stdin.isTTY) throw new Error("Pipe the message text to send on stdin");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > limit) throw new Error("stdin exceeds size limit");
  }
  if (!input.trim()) throw new Error("Message text is empty");
  return input;
}

async function runSocket(token, mode, details) {
  const startOnly = (mode === "new" || mode === "send") && !details.waitForReply;
  if (!repoRoot) throw new Error("Set BITTY_REPO_ROOT to resolve Runner WebSocket dependencies");
  const require = createRequire(path.join(repoRoot, "private_runner/package.json"));
  const WebSocket = require("ws");
  const url = new URL("/runner-ws", `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`,
    ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}),
  } });
  const subscriptionId = randomUUID();
  const operationId = randomUUID();
  const startRequestId = randomUUID();
  const responseRequestId = randomUUID();
  let runId = details.runId || "";
  let sessionRef = details.sessionRef || null;
  let settled = false;
  let responseSent = false;
  let reply = "";

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish({ status: runId ? "running" : "unknown", runId, operationId, sessionRef }), 5 * 60_000);
    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(value);
    }
    function send(op, requestId, payload, extra = {}) {
      ws.send(JSON.stringify({ channel: "agent", op, requestId, operationId: subscriptionId,
        ...(runId ? { streamId: runId } : {}), payload, ...extra }));
    }
    ws.on("open", () => {
      if (mode === "send" || mode === "new") {
        send("turn.start", startRequestId, {
          backendId: details.backendId || details.sessionRef.backendId,
          ...(details.sessionRef ? { sessionRef: details.sessionRef } : { cwd: details.cwd }),
          input: { blocks: [{ type: "text", text: details.input }] },
          ...(details.model ? { model: details.model } : {}),
          ...(details.effort ? { effort: details.effort } : {}),
          clientOperationId: operationId,
          subscriptionId,
          actionConsumer: "all",
          ...(details.policyProfileId ? { policyProfileId: details.policyProfileId } : {}),
        }, { operationId });
      } else {
        send("events.resume", startRequestId, { runId, subscriptionId, actionConsumer: "all" });
      }
    });
    ws.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.channel !== "agent") return;
      const payload = message.payload || {};
      if (message.streamId) runId = String(message.streamId);
      if (message.op === "error" && [startRequestId, responseRequestId].includes(message.requestId)) {
        finish(null, new Error(String(payload.message || payload.code || "Agent request failed")));
        return;
      }
      if (message.op === "turn.result" && message.requestId === startRequestId) {
        if (payload.sessionRef) sessionRef = payload.sessionRef;
        finish({ status: payload.outcome || "unknown", runId, sessionRef, reply, error: payload.error });
        return;
      }
      if (message.op === "turn.accepted" && message.requestId === startRequestId) {
        runId = String(payload.runId || message.streamId || runId);
        if (startOnly && sessionRef) finish({ status: "running", runId, operationId, sessionRef });
        return;
      }
      if (message.op === "events.resumed" && message.requestId === startRequestId) {
        if (payload.active === false) {
          finish({ status: "inactive", runId, sessionRef });
        } else if (mode === "respond") {
          responseSent = true;
          send("action.respond", responseRequestId, {
            runId, subscriptionId, requestId: details.requestId, decision: details.decision,
          });
        } else if (payload.activeActions?.length) {
          finish({ status: "action_required", runId, sessionRef, action: payload.activeActions[0] });
        }
        return;
      }
      if (message.op !== "event" || message.operationId !== subscriptionId) return;
      const event = payload;
      if (event.sessionRef) sessionRef = event.sessionRef;
      if (startOnly && event.type === "session.resolved" && sessionRef) {
        finish({ status: "running", runId, operationId, sessionRef });
      } else if (event.type === "item.completed" && event.payload?.itemType === "assistant") {
        reply = (Array.isArray(event.payload.content) ? event.payload.content : [])
          .filter((block) => block.type === "text")
          .map((block) => String(block.text || "")).join("");
      } else if (event.type === "action.requested") {
        const action = event.payload || {};
        if (mode === "respond" && action.requestId === details.requestId) return;
        finish({ status: "action_required", runId, sessionRef, action });
      } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
        finish({ status: event.type.slice(5), runId, sessionRef, reply, error: event.payload?.error });
      }
    });
    ws.on("error", (error) => finish(null, error));
    ws.on("close", () => {
      if (!settled) finish({ status: runId ? "running" : "unknown", runId, operationId, sessionRef,
        ...(responseSent ? { responseSent: true } : {}) });
    });
  });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validateTarget(target) {
  if (exactKeys(target, ["kind", "orchestratorId"]) && target.kind === "orchestrator" && identifier(target.orchestratorId)) return target;
  if (exactKeys(target, ["kind", "sessionRef", "cwd"]) && target.kind === "session"
    && exactKeys(target.sessionRef, ["backendId", "nativeSessionId"])
    && ["codex", "claude"].includes(target.sessionRef.backendId) && identifier(target.sessionRef.nativeSessionId)
    && identifier(target.cwd) && path.isAbsolute(target.cwd)) return target;
  throw new Error("Expected an exact session {kind,sessionRef:{backendId,nativeSessionId},cwd} or orchestrator {kind,orchestratorId} target");
}

async function control(token, action, opts) {
  if (action === "result") {
    assertOptions(opts, ["--operation"]);
    const id = required(opts, "--operation");
    if (!/^[A-Za-z0-9_-]{1,120}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid operation ID");
    const result = await http(token, `/app-control/operations/${encodeURIComponent(id)}`, null, {}, 5000);
    if (result.operationId !== id || typeof result.status !== "string") return { operationId: id, status: "operation_status_unknown" };
    return result;
  }
  if (!["status", "stop", "handoff"].includes(action)) throw new Error(usage);
  assertOptions(opts, ["--context"]);
  const context = required(opts, "--context");
  if (!identifier(context)) throw new Error("Invalid context");
  // Validate stdin before making any request; handoff never accepts origin or caller overrides.
  const target = action === "handoff" ? validateTarget(JSON.parse(await readInput(16 * 1024))) : undefined;
  let status = await http(token, `/app-control/contexts/${encodeURIComponent(context)}`, null, {}, 5000);
  const contextDeadline = Date.now() + 1000;
  while (action !== "status" && status.status === "pending_session_resolution" && Date.now() < contextDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (Date.now() >= contextDeadline) break;
    status = await http(token, `/app-control/contexts/${encodeURIComponent(context)}`, null, {}, Math.max(1, contextDeadline - Date.now()));
  }
  if (action === "status" || status.status !== "ready") return status;
  if (typeof status.epoch !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(status.epoch)
    || !Number.isSafeInteger(status.expectedGeneration) || status.expectedGeneration < 0) throw new Error("Invalid context response");
  const operationId = `${status.epoch}.${randomUUID()}`;
  console.error(operationId);
  // Print the ID before POST, including on disconnect. Only GET may recover its result.
  try {
    let result = await http(token, "/app-control/operations", null, {
      method: "POST", body: JSON.stringify({ operationId, context, action, expectedGeneration: status.expectedGeneration,
        ...(target ? { target } : {}) }),
    }, 5000);
    const deadline = Date.now() + (action === "stop" ? 5000 : 15000);
    while (result.status === "pending" && result.reason !== "waiting_for_caller_reply" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      result = await http(token, `/app-control/operations/${encodeURIComponent(operationId)}`, null, {}, Math.max(1, Math.min(5000, deadline - Date.now())));
    }
    if (result.operationId !== operationId || typeof result.status !== "string") throw new Error("Invalid operation response");
    return result;
  } catch (error) {
    if (!error.result?.status) error.result = { operationId, status: "operation_status_unknown" };
    throw error;
  }
}

async function listOrchestrators(token) {
  if (!repoRoot) throw new Error("Set BITTY_REPO_ROOT to resolve Runner WebSocket dependencies");
  const require = createRequire(path.join(repoRoot, "private_runner/package.json"));
  const WebSocket = require("ws");
  const url = new URL("/runner-ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, followRedirects: false });
  const requestId = randomUUID();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(null, new Error("Orchestrator list timed out")), 5000);
    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error); else resolve(value);
    }
    ws.on("open", () => ws.send(JSON.stringify({ channel: "agent", op: "voice.orchestrators.list", requestId, payload: {} })));
    ws.on("message", data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.channel !== "agent" || message.requestId !== requestId) return;
      if (message.op === "voice.orchestrators.list.result") {
        if (!Array.isArray(message.payload?.orchestrators)) return finish(null, new Error("Invalid orchestrator list"));
        finish({ orchestrators: message.payload.orchestrators.map(({ id, name }) => ({ id, name })),
          ...(message.payload.selectedOrchestratorId ? { selectedOrchestratorId: message.payload.selectedOrchestratorId } : {}) });
      } else if (message.op === "error") finish(null, new Error(String(message.payload?.code || "Orchestrator list failed")));
    });
    ws.on("error", error => finish(null, error));
    ws.on("close", () => finish(null, new Error("Orchestrator list disconnected")));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return console.log(usage);
  baseUrl = runnerOrigin();
  const subcommand = command === "control" ? args.shift() : null;
  const opts = options(args);
  const token = await auth();
  let result;
  if (command === "control") {
    result = await control(token, subcommand, opts);
  } else if (command === "orchestrators") {
    assertOptions(opts, []);
    result = await listOrchestrators(token);
  } else if (command === "workspaces") {
    assertOptions(opts, []);
    result = await http(token, "/agent/workspaces");
  } else if (command === "sessions") {
    assertOptions(opts, ["--cwd", "--backend", "--cursor"]);
    result = await http(token, "/agent/sessions", {
      cwd: required(opts, "--cwd"), backendId: opts["--backend"] || "all", cursor: opts["--cursor"],
    });
  } else if (command === "board") {
    assertOptions(opts, []);
    result = await http(token, "/skia-board");
  } else if (command === "board-apply") {
    assertOptions(opts, []);
    const body = JSON.parse(await readInput());
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !Number.isInteger(body.baseRevision) || body.baseRevision < 0
      || !Array.isArray(body.ops) || body.ops.length === 0 || body.ops.length > 100
      || body.ops.some((op) => !op || typeof op !== "object" || Array.isArray(op) || typeof op.type !== "string")) {
      throw new Error("Expected { baseRevision: non-negative integer, ops: [1–100 operation objects] }");
    }
    result = await http(token, "/skia-board/ops", null, {
      method: "POST",
      body: JSON.stringify({ baseRevision: body.baseRevision, ops: body.ops }),
    });
    if (!result.initialized || !Array.isArray(result.board?.cards)
      || !Number.isInteger(result.revision) || result.revision < body.baseRevision) {
      throw new Error("Invalid board response; check the current board before retrying");
    }
  } else if (command === "board-remove") {
    assertOptions(opts, ["--session", "--backend", "--cwd"]);
    const sessionId = required(opts, "--session");
    const backendId = opts["--backend"];
    const cwd = opts["--cwd"];
    const snapshot = await http(token, "/skia-board");
    if (!snapshot.initialized || !snapshot.board || !Array.isArray(snapshot.board.cards)) {
      throw new Error("Skia board is not initialized");
    }
    const matches = snapshot.board.cards.filter((card) => card.kind === "session" && card.sessionId === sessionId);
    if (matches.length !== 1) throw new Error(`Expected one session card, found ${matches.length}: ${sessionId}`);
    const card = matches[0];
    if (backendId && card.backendId && card.backendId !== backendId) {
      throw new Error(`Session card backend mismatch: ${card.backendId}`);
    }
    if (cwd && card.directory && card.directory !== cwd) {
      throw new Error(`Session card directory mismatch: ${card.directory}`);
    }
    const updated = await http(token, "/skia-board/ops", null, {
      method: "POST",
      body: JSON.stringify({
        baseRevision: snapshot.revision,
        ops: [{ type: "removeCard", cardId: `session:${sessionId}` }],
      }),
    });
    if (updated.board?.cards?.some((entry) => entry.kind === "session" && entry.sessionId === sessionId)
      || !updated.board?.excludedSessionIds?.includes(sessionId)) {
      throw new Error(`Session card removal could not be verified: ${sessionId}`);
    }
    result = { removed: true, sessionId, revision: updated.revision };
  } else if (command === "models") {
    assertOptions(opts, ["--backend"]);
    const backendId = required(opts, "--backend");
    const status = await http(token, "/agent/backends/status");
    const backend = (status.backends || []).find((entry) => entry.backendId === backendId);
    if (!backend) throw new Error(`Backend is unavailable: ${backendId}`);
    result = { backendId, readiness: backend.readiness, model: backend.capabilities?.model || {} };
  } else if (command === "handoff") {
    assertOptions(opts, ["--backend", "--session"]);
    result = await http(token, "/agent/session-mode", null, { method: "POST", body: JSON.stringify({
      sessionRef: { backendId: required(opts, "--backend"), nativeSessionId: required(opts, "--session") },
      targetMode: "neutral",
    }) });
  } else if (command === "send") {
    assertOptions(opts, ["--backend", "--session", "--model", "--effort", "--wait"]);
    const sessionRef = { backendId: required(opts, "--backend"), nativeSessionId: required(opts, "--session") };
    const input = await readInput();
    const policyProfileId = await interactiveProfile(token, sessionRef.backendId);
    result = await runSocket(token, "send", {
      sessionRef, input, policyProfileId, model: opts["--model"], effort: opts["--effort"], waitForReply: opts["--wait"],
    });
  } else if (command === "new") {
    assertOptions(opts, ["--backend", "--cwd", "--model", "--effort", "--wait"]);
    const backendId = required(opts, "--backend");
    const cwd = required(opts, "--cwd");
    const input = await readInput();
    const policyProfileId = await interactiveProfile(token, backendId);
    result = await runSocket(token, "new", {
      backendId, cwd, input, policyProfileId, model: opts["--model"], effort: opts["--effort"], waitForReply: opts["--wait"],
    });
  } else if (command === "wait" || command === "respond") {
    assertOptions(opts, command === "wait" ? ["--run"] : ["--run", "--request", "--decision"]);
    const details = { runId: required(opts, "--run") };
    if (command === "respond") {
      details.requestId = required(opts, "--request");
      details.decision = required(opts, "--decision");
      if (!["allow", "allow_for_session", "deny"].includes(details.decision)) throw new Error("Invalid decision");
    }
    result = await runSocket(token, command, details);
  } else {
    throw new Error(usage);
  }
  console.log(JSON.stringify(result));
  if (["failed", "interrupted", "unknown", "operation_status_unknown"].includes(result?.status)
    || (command === "control" && !["ready", "pending", "applied", "already_applied"].includes(result?.status))) process.exitCode = 1;
}

main().catch((error) => {
  if (process.argv[2] === "control") console.log(JSON.stringify(error.result || { status: "failed", error: String(error.message || error) }));
  else console.error(String(error.message || error));
  process.exitCode = 1;
});
