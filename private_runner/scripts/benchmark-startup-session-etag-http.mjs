// Isolated HTTP prototype: actual fetch/304 with synthetic Claude files, never the live Runner.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClaudeBackend } from '../src/claude-backend.mjs';

const temp = await fs.mkdtemp('/tmp/bitty-session-etag-http-');
const project = path.join(temp, 'projects', 'synthetic');
const cwds = Array.from({ length: 25 }, (_, i) => path.join(temp, 'workspace', String(i)));
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (cwd, title) => `${JSON.stringify({ type: 'user', cwd, timestamp: '2026-10-27T00:00:00Z', message: { content: title } })}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let profile = { name: 'loopback', delayMs: 0, bodyBytesPerSecond: 0 };
let nextBodyAt = 0;
let failListing = false;
let server;
try {
  await fs.mkdir(project, { recursive: true });
  for (let i = 0; i < cwds.length; i++) {
    await fs.mkdir(cwds[i], { recursive: true });
    for (let j = 0; j < 5; j++) await fs.writeFile(path.join(project, `${uuid(i * 5 + j)}.jsonl`), row(cwds[i], `main-${i}-${j}`));
  }
  const counts = { readdir: 0, realpath: 0, stat: 0, readFile: 0 };
  const fileSystem = { ...fs };
  for (const op of Object.keys(counts)) fileSystem[op] = (...args) => { counts[op]++; return fs[op](...args); };
  const backend = createClaudeBackend({ projectsRoot: path.join(temp, 'projects'), fileSystem, sessionStore: { getBinding: async () => null } });
  server = http.createServer(async (req, res) => {
    try {
      const directory = Number(new URL(req.url, 'http://localhost').searchParams.get('directory'));
      assert.ok(Number.isInteger(directory) && directory >= 0 && directory < cwds.length);
      if (profile.delayMs) await sleep(profile.delayMs);
      if (failListing) throw new Error('synthetic list failure');
      const scanStart = performance.now();
      const snapshot = await backend.listSessions({ cwd: cwds[directory], limit: 5, includeSubagents: false });
      const scanMs = performance.now() - scanStart;
      const encodeStart = performance.now();
      const body = Buffer.from(JSON.stringify(snapshot));
      const encodeMs = performance.now() - encodeStart;
      const hashStart = performance.now();
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      const hashMs = performance.now() - hashStart;
      const notModified = req.headers['if-none-match'] === etag;
      res.writeHead(notModified ? 304 : 200, {
        etag, 'cache-control': 'private, no-cache', 'content-type': 'application/json',
        'x-benchmark-timings': JSON.stringify({ scanMs, encodeMs, hashMs }),
        ...(!notModified ? { 'content-length': body.length } : {}),
      });
      if (notModified) return res.end();
      res.flushHeaders();
      for (let offset = 0; offset < body.length; offset += 1024) {
        const chunk = body.subarray(offset, offset + 1024);
        if (profile.bodyBytesPerSecond) {
          nextBodyAt = Math.max(performance.now(), nextBodyAt) + chunk.length * 1000 / profile.bodyBytesPerSecond;
          await sleep(nextBodyAt - performance.now());
        }
        res.write(chunk);
      }
      res.end();
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic list failure' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cache = new Map();
  async function request(directory, conditional) {
    const started = performance.now();
    const previous = cache.get(directory);
    const response = await fetch(`${baseUrl}/sessions?directory=${directory}`, {
      headers: conditional && previous ? { 'if-none-match': previous.etag } : {},
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headerBytesApprox = Buffer.byteLength(`HTTP/1.1 ${response.status} ${response.statusText}\r\n\r\n`)
      + [...response.headers].reduce((total, [name, value]) => total + Buffer.byteLength(`${name}: ${value}\r\n`), 0);
    let snapshot;
    if (response.status === 304) {
      assert.ok(previous);
      assert.equal(body.length, 0);
      assert.equal(response.headers.get('etag'), previous.etag);
      snapshot = previous.snapshot; // No JSON.parse on a real 304.
    } else if (response.ok) {
      snapshot = JSON.parse(body.toString());
      cache.set(directory, { etag: response.headers.get('etag'), snapshot });
    }
    return { status: response.status, snapshot, bytes: body.length, headerBytesApprox,
      jsonParses: response.status === 200 ? 1 : 0, clientMs: performance.now() - started,
      ...JSON.parse(response.headers.get('x-benchmark-timings') || '{}') };
  }
  async function run(conditional) {
    for (const op of Object.keys(counts)) counts[op] = 0;
    const started = performance.now();
    const requests = Array(cwds.length);
    let next = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < cwds.length) { const i = next++; requests[i] = await request(i, conditional); }
    }));
    assert.ok(requests.every((result) => result.status === (conditional ? 304 : 200)));
    return { seconds: (performance.now() - started) / 1000, counts: { ...counts },
      totals: Object.fromEntries(['bytes', 'headerBytesApprox', 'jsonParses', 'scanMs', 'encodeMs', 'hashMs'].map((key) => [key, requests.reduce((sum, result) => sum + result[key], 0)])),
      requestMs: { min: Math.min(...requests.map((r) => r.clientMs)), median: median(requests.map((r) => r.clientMs)), max: Math.max(...requests.map((r) => r.clientMs)) },
      snapshots: requests.map((result) => result.snapshot) };
  }
  const results = [];
  for (const link of [{ name: 'loopback', delayMs: 0, bodyBytesPerSecond: 0 }, { name: 'controlled', delayMs: 80, bodyBytesPerSecond: 125_000 }]) {
    profile = link;
    nextBodyAt = 0;
    await run(false); // Warm metadata, validators and two client connections outside timing.
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      const pair = {};
      for (const name of (round % 2 ? ['conditional', 'full'] : ['full', 'conditional'])) pair[name] = await run(name === 'conditional');
      assert.deepEqual(pair.conditional.snapshots, pair.full.snapshots);
      rounds.push(Object.fromEntries(Object.entries(pair).map(([name, { snapshots, ...measurement }]) => [name, measurement])));
    }
    const summary = Object.fromEntries(['full', 'conditional'].map((name) => [name, {
      medianSeconds: median(rounds.map((round) => round[name].seconds)), minSeconds: Math.min(...rounds.map((round) => round[name].seconds)), maxSeconds: Math.max(...rounds.map((round) => round[name].seconds)),
      medianTotals: Object.fromEntries(Object.keys(rounds[0][name].totals).map((key) => [key, median(rounds.map((round) => round[name].totals[key]))])), countsPerRound: rounds[0][name].counts,
    }]));
    results.push({ profile: link, summary, rounds });
  }
  profile = { name: 'validation', delayMs: 0, bodyBytesPerSecond: 0 };
  const changedFile = path.join(project, `${uuid(0)}.jsonl`);
  await fs.writeFile(changedFile, row(cwds[0], 'updated title with different length'));
  await fs.utimes(changedFile, new Date('2026-10-28T00:00:00Z'), new Date('2026-10-28T00:00:00Z'));
  const updated = await request(0, true);
  assert.equal(updated.status, 200);
  assert.equal(updated.snapshot.sessions[0].title, 'updated title with different length');
  const addedFile = path.join(project, `${uuid(10000)}.jsonl`);
  await fs.writeFile(addedFile, row(cwds[0], 'new session'));
  await fs.utimes(addedFile, new Date('2026-10-29T00:00:00Z'), new Date('2026-10-29T00:00:00Z'));
  const added = await request(0, true);
  assert.equal(added.status, 200);
  assert.equal(added.snapshot.sessions[0].title, 'new session');
  await fs.unlink(changedFile);
  const deleted = await request(0, true);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.snapshot.sessions.some((session) => session.sessionRef.nativeSessionId === uuid(0)), false);
  assert.equal((await request(0, true)).status, 304);
  const beforeError = cache.get(0);
  failListing = true;
  assert.equal((await request(0, true)).status, 500);
  assert.equal(cache.get(0), beforeError);
  failListing = false;
  assert.equal((await request(0, true)).status, 304);
  console.log(JSON.stringify({ fixture: { directories: 25, mainSessions: 125, children: 0, concurrency: 2 }, results,
    checked: ['real HTTP 200/304', '304 has no body or JSON parse', 'all snapshots equal', 'new/update/delete force fresh 200', 'listing failure returns 500, cache preserved, retry recovers'],
    limitations: ['HTTP prototype, not production WebSocket sessions.list', 'controlled delay and globally shared 1Mbps body pacing are injected, headers not paced', 'scan/hash/serialization totals sum per-request work and can overlap', 'header bytes approximate; TCP/TLS/request headers excluded', 'loopback, synthetic Claude only; no app, auth, Codex or real mobile link'] }, null, 2));
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await fs.rm(temp, { recursive: true, force: true });
}
