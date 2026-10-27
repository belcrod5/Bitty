// Synthetic real-fs experiment only. No Runner, app restart, user history or production changes.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClaudeBackend } from '../src/claude-backend.mjs';

const temp = await fs.mkdtemp('/tmp/bitty-session-cache-');
const project = path.join(temp, 'projects', 'synthetic');
const cwds = Array.from({ length: 25 }, (_, i) => path.join(temp, 'workspace', String(i)));
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (cwd, title) => `${JSON.stringify({ type: 'user', cwd, timestamp: '2026-10-27T00:00:00Z', message: { content: title } })}\n`;
const digest = (body) => createHash('sha256').update(body).digest('hex');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  await fs.mkdir(project, { recursive: true });
  for (let i = 0; i < cwds.length; i++) {
    await fs.mkdir(cwds[i], { recursive: true });
    for (let j = 0; j < 5; j++) {
      const id = uuid(i * 5 + j);
      await fs.writeFile(path.join(project, `${id}.jsonl`), row(cwds[i], `main-${i}-${j}`));
      const children = path.join(project, id, 'subagents');
      await fs.mkdir(children, { recursive: true });
      for (let k = 0; k < 8; k++) await fs.writeFile(path.join(children, `agent-${i}-${j}-${k}.jsonl`), row(cwds[i], `child-${k}`));
    }
  }
  function instance() {
    const counts = { readdir: 0, realpath: 0, stat: 0, readFile: 0 };
    const fileSystem = { ...fs };
    for (const op of Object.keys(counts)) fileSystem[op] = (...args) => { counts[op]++; return fs[op](...args); };
    return { counts, backend: createClaudeBackend({ projectsRoot: path.join(temp, 'projects'), fileSystem, sessionStore: { getBinding: async () => null } }) };
  }
  async function measure(target, batch) {
    for (const op of Object.keys(target.counts)) target.counts[op] = 0;
    const start = performance.now();
    let pages;
    if (batch) {
      const { groups } = await target.backend.listSessionsForDirectories({ cwds, includeSubagents: false });
      pages = groups.map((group) => group.sessions.slice(0, 5));
    } else {
      pages = Array(cwds.length);
      let next = 0;
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (next < cwds.length) {
          const i = next++;
          const result = await target.backend.listSessions({ cwd: cwds[i], limit: 5, includeSubagents: false });
          pages[i] = result.sessions.map(({ cursor, ...session }) => session);
        }
      }));
    }
    return { seconds: (performance.now() - start) / 1000, counts: { ...target.counts }, pages };
  }
  const targets = { perDirectory: instance(), freshBatch: instance() };
  for (const target of Object.values(targets)) await target.backend.listSessionsForDirectories({ cwds, includeSubagents: false });
  const rounds = [];
  let previousBody;
  let unchangedBodyBytes;
  for (let i = 0; i < 5; i++) {
    const pair = {};
    for (const name of (i % 2 ? ['freshBatch', 'perDirectory'] : ['perDirectory', 'freshBatch'])) pair[name] = await measure(targets[name], name === 'freshBatch');
    assert.deepEqual(pair.freshBatch.pages, pair.perDirectory.pages);
    assert.equal(pair.freshBatch.pages.flat().length, 125);
    const body = JSON.stringify(pair.freshBatch.pages);
    if (previousBody) {
      const notModified = digest(body) === digest(previousBody);
      assert.equal(notModified, true);
      unchangedBodyBytes = Buffer.byteLength(notModified ? "" : body);
      assert.equal(unchangedBodyBytes, 0);
    }
    previousBody = body;
    rounds.push(Object.fromEntries(Object.entries(pair).map(([name, { seconds, counts }]) => [name, { seconds, counts }])));
  }
  const previousTag = digest(previousBody);
  const changedFile = path.join(project, `${uuid(0)}.jsonl`);
  const addedFile = path.join(project, `${uuid(10000)}.jsonl`);
  const checkFresh = async () => {
    const perDirectory = await measure(targets.perDirectory, false);
    const batch = await measure(targets.freshBatch, true);
    assert.deepEqual(batch.pages, perDirectory.pages);
    return batch.pages;
  };
  await fs.writeFile(changedFile, row(cwds[0], 'updated title of different length'));
  await fs.utimes(changedFile, new Date('2026-10-28T00:00:00Z'), new Date('2026-10-28T00:00:00Z'));
  const updated = await checkFresh();
  assert.equal(updated[0][0].title, 'updated title of different length');
  assert.notEqual(digest(JSON.stringify(updated)), previousTag);
  await fs.writeFile(addedFile, row(cwds[0], 'new session'));
  await fs.utimes(addedFile, new Date('2026-10-29T00:00:00Z'), new Date('2026-10-29T00:00:00Z'));
  assert.equal((await checkFresh())[0][0].title, 'new session');
  await fs.unlink(changedFile);
  const deleted = await checkFresh();
  assert.equal(deleted[0].some((session) => session.sessionRef.nativeSessionId === uuid(0)), false);
  const summary = Object.fromEntries(Object.keys(targets).map((name) => [name, {
    medianSeconds: median(rounds.map((round) => round[name].seconds)),
    minSeconds: Math.min(...rounds.map((round) => round[name].seconds)),
    maxSeconds: Math.max(...rounds.map((round) => round[name].seconds)),
    ioCountsPerRound: rounds[0][name].counts,
  }]));
  console.log(JSON.stringify({
    fixture: { directories: 25, mainSessions: 125, children: 1000, concurrencyPerDirectory: 2, rounds: 5, warmMetadata: true },
    summary, rounds,
    conditionalPayloadPrototype: { fullBodyBytes: Buffer.byteLength(previousBody), unchangedBodyBytes, validator: 'sha256 after fresh listing', networkMeasured: false },
    checked: ['raw first-page rows equal excluding cursor', 'new session', 'updated title', 'deleted session', 'validator changes after update'],
    limitations: ['Claude only; artificial child count', 'batch returns no page cursors or Agent summaries/client titles', 'no app, TLS, storage hydration, HTTP or WebSocket timing', 'ETag prototype still computes fresh list; no server scan savings'],
  }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
