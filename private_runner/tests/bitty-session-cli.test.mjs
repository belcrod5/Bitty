import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repoRoot, 'skills/bitty-session-orchestrator/scripts/bitty-session.mjs');
const dependencyRepo = process.env.BITTY_REPO_ROOT || repoRoot;
const require = createRequire(path.join(dependencyRepo, 'private_runner/package.json'));
const { WebSocketServer } = require('ws');

async function fixture(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitty-control-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  await fs.writeFile(tokenFile, 'test-private-token\n', { mode: 0o600 });
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const entry = { url: request.url, method: request.method, headers: request.headers, body: body ? JSON.parse(body) : null };
    requests.push(entry);
    response.setHeader('content-type', 'application/json');
    await handler(entry, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, BITTY_REPO_ROOT: dependencyRepo, BITTY_RUNNER_TOKEN_FILE: tokenFile,
    BITTY_RUNNER_URL: `http://127.0.0.1:${server.address().port}`, CODEX_THREAD_ID: 'display-only' };
  const run = (args, input = '', overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...overrides }, cwd: dir });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  return { run, requests, tokenFile, server, dir };
}
const ready = { context: 'ctx_current', status: 'ready', epoch: 'epoch-1', expectedGeneration: 7 };
const send = (response, value) => response.end(JSON.stringify(value));

test('control mutation uses trusted context generation, prints recoverable ID, never forwards display identity as authority', async t => {
  const f = await fixture(t, (request, response) => send(response, request.method === 'POST'
    ? { operationId: request.body.operationId, status: 'applied', desired: 'stopped', observed: 'stopped' } : ready));
  const result = await f.run(['control', 'stop', '--context', 'ctx_current']);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.match(result.stderr, /^epoch-1\.[0-9a-f-]{36}\n$/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].body, { operationId: result.stderr.trim(), context: 'ctx_current', action: 'stop', expectedGeneration: 7 });
  for (const request of f.requests) assert.equal(request.headers.authorization, 'Bearer test-private-token');
  assert.ok(!result.stdout.includes('test-private-token'));
});

test('same-target caller reply waiting returns without a result poll', async t => {
  const f = await fixture(t, (request, response) => send(response, request.method === 'POST'
    ? { operationId: request.body.operationId, status: 'pending', reason: 'waiting_for_caller_reply' } : ready));
  const target = { kind: 'orchestrator', orchestratorId: 'main' };
  const result = await f.run(['control', 'handoff', '--context', 'ctx_current'], JSON.stringify(target));
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).reason, 'waiting_for_caller_reply');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[1].body.target, target);
});

test('pending operation polls only GET with the original ID', async t => {
  let id;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') { id = request.body.operationId; return send(response, { operationId: id, status: 'pending' }); }
    send(response, request.url.includes('/operations/') ? { operationId: id, status: 'applied' } : ready);
  });
  const result = await f.run(['control', 'stop', '--context', 'ctx_current']);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).url, `/app-control/operations/${id}`);
});

test('uncertain POST prints operation ID, returns unknown and never retries', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') response.destroy(); else send(response, ready);
  });
  const result = await f.run(['control', 'stop', '--context', 'ctx_current']);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).status, 'operation_status_unknown');
  assert.equal(JSON.parse(result.stdout).operationId, result.stderr.trim());
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('stale context cannot become a mutation or successful result', async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = 410; send(response, { status: 'context_expired' }); });
  const result = await f.run(['control', 'stop', '--context', 'ctx_old']);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).status, 'context_expired');
  assert.equal(result.stderr, ''); assert.equal(f.requests.length, 1);
});

test('exact bounded stdin target rejects caller override, malformed and oversized inputs before network', async t => {
  const f = await fixture(t, (_, response) => send(response, ready));
  for (const target of [JSON.stringify({ kind: 'orchestrator', orchestratorId: 'main', callerId: 'other' }), '{}', 'x'.repeat(17000),
    JSON.stringify({ kind: 'session', sessionRef: { backendId: 'codex', nativeSessionId: 'id' }, cwd: '../other' })]) {
    const result = await f.run(['control', 'handoff', '--context', 'ctx_current'], target);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).status, 'failed');
  }
  assert.equal(f.requests.length, 0);
});

test('token symlink, public token mode and non-local HTTP origin are rejected without requests', async t => {
  const f = await fixture(t, (_, response) => send(response, ready));
  const link = path.join(f.dir, 'token-link'); await fs.symlink(f.tokenFile, link);
  assert.equal((await f.run(['control', 'status', '--context', 'ctx_current'], '', { BITTY_RUNNER_TOKEN_FILE: link })).code, 1);
  await fs.chmod(f.tokenFile, 0o644);
  assert.equal((await f.run(['control', 'status', '--context', 'ctx_current'])).code, 1);
  assert.equal((await f.run(['control', 'status', '--context', 'ctx_current'], '', { BITTY_RUNNER_URL: 'http://example.com' })).code, 1);
  assert.equal(f.requests.length, 0);
});

test('redirect cannot forward bearer token to another origin', async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = 302; response.setHeader('location', 'http://127.0.0.1:1/stolen'); response.end(); });
  const result = await f.run(['control', 'status', '--context', 'ctx_current']);
  assert.equal(result.code, 1); assert.equal(f.requests.length, 1); assert.ok(!result.stdout.includes('test-private-token'));
});

test('orchestrators uses existing read-only list envelope, not selection or turn send', async t => {
  const f = await fixture(t, (_, response) => send(response, {}));
  const wss = new WebSocketServer({ server: f.server });
  t.after(() => wss.close());
  const messages = [];
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-private-token');
    socket.on('message', data => {
      const message = JSON.parse(String(data)); messages.push(message);
      socket.send(JSON.stringify({ channel: 'agent', op: 'voice.orchestrators.list.result', requestId: message.requestId,
        payload: { orchestrators: [{ id: 'main', name: 'メイン', systemInstruction: 'private' }], selectedOrchestratorId: 'main' } }));
    });
  });
  const result = await f.run(['orchestrators']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { orchestrators: [{ id: 'main', name: 'メイン' }], selectedOrchestratorId: 'main' });
  assert.equal(messages.length, 1); assert.equal(messages[0].op, 'voice.orchestrators.list');
});

test('existing discovery, board write and neutral handoff remain compatible', async t => {
  const f = await fixture(t, (request, response) => send(response, request.url === '/skia-board/ops'
    ? { initialized: true, revision: 2, board: { cards: [] } } : { ok: true }));
  assert.equal((await f.run(['sessions', '--cwd', '/approved/work', '--backend', 'claude', '--cursor', 'next'])).code, 0);
  assert.equal(f.requests.at(-1).url, '/agent/sessions?cwd=%2Fapproved%2Fwork&backendId=claude&cursor=next');
  assert.equal((await f.run(['board-apply'], JSON.stringify({ baseRevision: 1, ops: [{ type: 'tidyCards' }] }))).code, 0);
  assert.equal((await f.run(['handoff', '--backend', 'codex', '--session', 'session-id'])).code, 0);
  assert.deepEqual(f.requests.at(-1).body, { sessionRef: { backendId: 'codex', nativeSessionId: 'session-id' }, targetMode: 'neutral' });
});

test('result lookup never mutates and unknown status is unsuccessful', async t => {
  const id = 'epoch-1.00000000-0000-4000-8000-000000000001';
  const f = await fixture(t, (_, response) => send(response, { operationId: id, status: 'operation_status_unknown' }));
  const result = await f.run(['control', 'result', '--operation', id]);
  assert.equal(result.code, 1); assert.equal(result.stderr, '');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].url, `/app-control/operations/${id}`);
});

test('existing send/new/wait/respond preserve Runner envelopes and results', async t => {
  const f = await fixture(t, (_, response) => send(response, { backends: [{ backendId: 'codex', capabilities: { action: { policyProfiles: [{ id: 'interactive', interactive: true }] } } }] }));
  const wss = new WebSocketServer({ server: f.server }); t.after(() => wss.close());
  const messages = [];
  wss.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(String(data)); messages.push(message);
    if (message.op === 'turn.start') {
      socket.send(JSON.stringify({ channel: 'agent', op: 'turn.result', requestId: message.requestId,
        payload: { outcome: 'completed', sessionRef: { backendId: 'codex', nativeSessionId: 'new-session' } } }));
    } else if (message.op === 'events.resume') {
      socket.send(JSON.stringify({ channel: 'agent', op: 'events.resumed', requestId: message.requestId,
        payload: { active: message.payload.runId === 'respond-run' } }));
    } else if (message.op === 'action.respond') {
      socket.send(JSON.stringify({ channel: 'agent', op: 'event', operationId: message.operationId,
        payload: { type: 'turn.completed', payload: {} } }));
    }
  }));
  assert.equal((await f.run(['new', '--backend', 'codex', '--cwd', '/approved/work'], 'new message')).code, 0);
  assert.equal(messages.at(-1).payload.input.blocks[0].text, 'new message');
  assert.equal(messages.at(-1).payload.cwd, '/approved/work');
  assert.equal(messages.at(-1).payload.policyProfileId, 'interactive');
  assert.equal((await f.run(['send', '--backend', 'codex', '--session', 's-id', '--model', 'requested-model', '--effort', 'low'], 'send message')).code, 0);
  assert.deepEqual(messages.at(-1).payload.sessionRef, { backendId: 'codex', nativeSessionId: 's-id' });
  assert.equal(messages.at(-1).payload.model, 'requested-model');
  assert.equal((await f.run(['wait', '--run', 'idle-run'])).code, 0);
  assert.equal(messages.at(-1).op, 'events.resume');
  assert.equal((await f.run(['respond', '--run', 'respond-run', '--request', 'approval-1', '--decision', 'deny'])).code, 0);
  assert.equal(messages.at(-1).op, 'action.respond'); assert.equal(messages.at(-1).payload.decision, 'deny');
  assert.ok(messages.every(message => !Object.hasOwn(message.payload, 'controlContext')));
});

test('initial native session resolution is confirmed before operation dispatch', async t => {
  let contextReads = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') return send(response, { operationId: request.body.operationId, status: 'applied' });
    contextReads += 1;
    send(response, contextReads === 1 ? { ...ready, status: 'pending_session_resolution' } : ready);
  });
  const result = await f.run(['control', 'stop', '--context', 'ctx_current']);
  assert.equal(result.code, 0); assert.equal(contextReads, 2);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'GET', 'POST']);
});

test('malformed token cannot leak through HTTP or WebSocket header validation errors', async t => {
  const f = await fixture(t, (_, response) => send(response, ready));
  await fs.writeFile(f.tokenFile, 'private-token\nembedded-private-token');
  for (const args of [['control', 'status', '--context', 'ctx_current'], ['orchestrators']]) {
    const result = await f.run(args);
    assert.equal(result.code, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('private-token'));
  }
  assert.equal(f.requests.length, 0);
});
