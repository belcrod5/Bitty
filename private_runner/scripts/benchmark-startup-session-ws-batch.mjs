// Production WS batch transport versus the former per-directory request pattern; synthetic files only.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createClaudeBackend } from '../src/claude-backend.mjs';
import { createAgentService } from '../src/agent/agent-service.mjs';
import { createAgentWsConnection } from '../src/agent/agent-transport.mjs';
import { agentError } from '../src/agent/agent-protocol.mjs';
import { operationStore, sessionStore } from '../tests/agent-service-fixtures.mjs';
const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws');
const temp = await fs.mkdtemp('/tmp/bitty-session-ws-batch-');
const project = path.join(temp, 'projects', 'synthetic');
const cwds = Array.from({ length: 25 }, (_, i) => path.join(temp, 'workspace', String(i)));
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (cwd, title) => `${JSON.stringify({ type: 'user', cwd, timestamp: '2026-10-27T00:00:00Z', message: { content: title } })}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let delayMs = 0;
let failedCwd = '';
let ws;
let server;
try {
  await fs.mkdir(project, { recursive: true });
  for (let i = 0; i < cwds.length; i++) {
    await fs.mkdir(cwds[i], { recursive: true });
    for (let j = 0; j < 6; j++) {
      const file = path.join(project, `${uuid(i * 6 + j)}.jsonl`);
      await fs.writeFile(file, row(cwds[i], `main-${i}-${j}`));
      const timestamp = new Date(Date.parse('2026-10-27T00:00:00Z') + j * 1000);
      await fs.utimes(file, timestamp, timestamp);
    }
  }
  const counts = { readdir: 0, realpath: 0, stat: 0, readFile: 0, backendStatus: 0, backendList: 0, serviceList: 0 };
  const fileSystem = { ...fs };
  for (const op of ['readdir', 'realpath', 'stat', 'readFile']) fileSystem[op] = (...args) => { counts[op]++; return fs[op](...args); };
  const store = sessionStore();
  store.setDirectoryLastReadAt(cwds[0], '2026-10-26T00:00:00Z');
  const backend = createClaudeBackend({ projectsRoot: path.join(temp, 'projects'), fileSystem, sessionStore: store });
  const nativeList = backend.listSessions;
  backend.getStatus = async () => { counts.backendStatus++; return { backendId: 'claude', available: true, readiness: { ready: true }, capabilities: { session: { list: true } } }; };
  backend.listSessions = async (options) => {
    counts.backendList++;
    if (options.cwd === failedCwd) throw agentError('backend_unavailable', 'synthetic directory failure', { backendId: 'claude' });
    return nativeList(options);
  };
  const service = createAgentService({ backends: [backend], operationStore: operationStore(), sessionStore: store,
    workspaceAdmission: { assertAllowed: async (_subject, cwd) => cwd }, resolveCanonicalCwd: async (cwd) => cwd,
    getSessionTitles: async (refs) => refs.map((ref) => ref.nativeSessionId === uuid(4) ? 'shared title override' : '') });
  const nativeServiceList = service.listSessions;
  service.listSessions = (...args) => { counts.serviceList++; return nativeServiceList(...args); };
  const subjectId = 'synthetic-reader';
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const options = cwds.map((cwd) => ({ backendId: 'all', cwd, limit: 5, includeSubagents: false }));
  server.on('connection', (socket) => {
    const connection = createAgentWsConnection({ service, ws: socket, subjectId, workspaceAdmission: {},
      sendEnvelope: (target, envelope) => target.send(JSON.stringify(envelope)) });
    socket.on('message', async (raw) => {
      const message = JSON.parse(raw.toString());
      if (delayMs) await sleep(delayMs);
      connection.handleMessage(message);
    });
    socket.on('close', () => connection.detach());
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let requestSequence = 0;
  let traffic = { requests: 0, sentBytes: 0, receivedBytes: 0 };
  const pending = new Map();
  ws.on('message', (raw) => {
    traffic.receivedBytes += raw.length;
    const message = JSON.parse(raw.toString());
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(message.requestId);
    waiter.resolve(message.op === 'error' ? { error: message.payload } : { payload: message.payload });
  });
  function request(op, payload = {}) {
    const requestId = String(++requestSequence).padStart(6, '0');
    const wire = JSON.stringify({ channel: 'agent', op, requestId, payload });
    traffic.requests++;
    traffic.sentBytes += Buffer.byteLength(wire);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('benchmark request timeout')); }, 10_000);
      pending.set(requestId, { resolve, timeout });
      ws.send(wire);
    });
  }
  async function run(batch) {
    for (const key of Object.keys(counts)) counts[key] = 0;
    traffic = { requests: 0, sentBytes: 0, receivedBytes: 0 };
    const started = performance.now();
    let selectedUsableSeconds;
    let groups;
    if (batch) {
      assert.ok((await request('agent.hello')).payload);
      groups = (await request('sessions.list.batch', { cwds, limit: 5 })).payload.groups.map(({ cwd, ...group }) => group);
      selectedUsableSeconds = (performance.now() - started) / 1000;
    } else {
      groups = Array(cwds.length);
      let next = 0;
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (next < cwds.length) {
          const i = next++;
          assert.ok((await request('agent.hello')).payload);
          groups[i] = await request('sessions.list', options[i]);
          if (i === 0) selectedUsableSeconds = (performance.now() - started) / 1000;
        }
      }));
    }
    return { seconds: (performance.now() - started) / 1000, selectedUsableSeconds, traffic: { ...traffic }, counts: { ...counts }, groups };
  }
  const results = [];
  const modes = ['perDirectory', 'batch'];
  for (const profile of [{ name: 'loopback', delayMs: 0 }, { name: 'controlled', delayMs: 80 }]) {
    delayMs = profile.delayMs;
    await run(false);
    await run(true);
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      const pair = {};
      const order = round % 2 ? [...modes].reverse() : [...modes];
      for (const mode of order) pair[mode] = await run(mode === 'batch');
      assert.deepEqual(pair.batch.groups, pair.perDirectory.groups);
      assert.ok(pair.batch.groups.every((group) => group.payload.sessions.length === 5 && group.payload.cursor));
      const selected = pair.batch.groups[0].payload.sessions;
      assert.equal(selected.find((session) => session.sessionRef.nativeSessionId === uuid(4)).title, 'shared title override');
      assert.ok(selected.every((session) => session.lastReadAt === '2026-10-26T00:00:00Z'));
      assert.equal(pair.perDirectory.traffic.requests, 50);
      assert.equal(pair.batch.traffic.requests, 2);
      assert.equal(pair.batch.counts.serviceList, 25);
      assert.equal(pair.batch.counts.backendStatus, 26);
      rounds.push({ order, ...Object.fromEntries(Object.entries(pair).map(([name, { groups, ...measurement }]) => [name, measurement])) });
    }
    const summary = Object.fromEntries(modes.map((mode) => [mode, {
      medianSeconds: median(rounds.map((round) => round[mode].seconds)), minSeconds: Math.min(...rounds.map((round) => round[mode].seconds)), maxSeconds: Math.max(...rounds.map((round) => round[mode].seconds)),
      selectedMedianSeconds: median(rounds.map((round) => round[mode].selectedUsableSeconds)), traffic: rounds[0][mode].traffic, countsPerRound: rounds[0][mode].counts,
    }]));
    results.push({ profile, summary, rounds });
  }
  delayMs = 0;
  const compareFresh = async () => {
    const ordinary = await run(false);
    const batch = await run(true);
    assert.deepEqual(batch.groups, ordinary.groups);
    return batch.groups;
  };
  const changedFile = path.join(project, `${uuid(5)}.jsonl`);
  await fs.writeFile(changedFile, row(cwds[0], 'updated native title with a different length'));
  await fs.utimes(changedFile, new Date('2026-10-28T00:00:00Z'), new Date('2026-10-28T00:00:00Z'));
  assert.equal((await compareFresh())[0].payload.sessions[0].title, 'updated native title with a different length');
  const addedFile = path.join(project, `${uuid(10000)}.jsonl`);
  await fs.writeFile(addedFile, row(cwds[0], 'new session'));
  await fs.utimes(addedFile, new Date('2026-10-29T00:00:00Z'), new Date('2026-10-29T00:00:00Z'));
  assert.equal((await compareFresh())[0].payload.sessions[0].title, 'new session');
  await fs.unlink(changedFile);
  const good = await compareFresh();
  assert.equal(good[0].payload.sessions.some((session) => session.sessionRef.nativeSessionId === uuid(5)), false);
  failedCwd = cwds[1];
  const partial = await compareFresh();
  assert.equal(partial[1].error.code, 'backend_unavailable');
  assert.equal(partial.filter((group) => group.payload).length, 24);
  const displayed = good.map((group) => group.payload);
  partial.forEach((group, i) => { if (group.payload) displayed[i] = group.payload; });
  assert.deepEqual(displayed[1], good[1].payload); // A failed directory retains old data, separately marked failed.
  failedCwd = '';
  assert.ok((await compareFresh()).every((group) => group.payload));
  console.log(JSON.stringify({ fixture: { directories: 25, mainSessions: 150, children: 0, concurrency: 2, staticReadyStatus: true }, results,
    checked: ['full wire payloads equal including cursor, title override and read state', '50 requests become 2 using production batch dispatch', '25 fresh service/backend list calls retained', 'new/update/delete visible', 'one failed directory preserves 24 successes and failed-group cache', 'later request recovers without lifetime cache'],
    limitations: ['same updated production server in both modes; baseline reproduces former 50-request pattern', 'hello reduction contributes; backend readiness still checked per list', 'first directory-list result waits for the batch; popup body is not measured', '80ms server delay is injected per WS request, not measured RTT', 'no TLS, app, real user data, Codex summaries or authentication lifecycle', 'transport batching and prior backend scan batching were not combined', 'byte counts exclude WS framing/TLS and connection startup is excluded'] }, null, 2));
} finally {
  ws?.terminate();
  if (server) { for (const client of server.clients) client.terminate(); await new Promise((resolve) => server.close(resolve)); }
  await fs.rm(temp, { recursive: true, force: true });
}
