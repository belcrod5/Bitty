// Isolated real-fs comparison; no Runner, user history, or production source changes.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const sourcePath = fileURLToPath(new URL('../src/claude-backend.mjs', import.meta.url));
const source = await fs.readFile(sourcePath, 'utf8');
const temp = await fs.mkdtemp('/tmp/bitty-claude-main-scan-');
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const root = path.join(temp, 'projects');
const project = path.join(root, 'synthetic');
const cwds = Array.from({ length: 25 }, (_, n) => path.join(temp, 'workspace', String(n)));
const rows = (cwd, title) => `${JSON.stringify({ type: 'user', cwd, timestamp: '2026-10-27T00:00:00Z', message: { content: title, model: 'sonnet' } })}\n`;
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, `source marker mismatch: ${before}`);
  return text.replace(before, after);
}
const candidate = source;
let current = replaceOnce(source, 'async function transcriptFileEntries(includeSubagents = true) {', 'async function transcriptFileEntries() {');
current = replaceOnce(current, '        if (includeSubagents === false) continue;\n', '');
current = replaceOnce(current, 'for (const entry of await transcriptFileEntries(includeSubagents)) {', 'for (const entry of await transcriptFileEntries()) {\n      if (includeSubagents === false && entry.parentSessionId) continue;');
function absoluteImports(text) {
  return text.replace(/from "(\.\/[^"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href)}`)
    .replace('new URL("../tools/claude-permission-prompt-mcp.mjs", import.meta.url)', `new URL(${JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), '../tools/claude-permission-prompt-mcp.mjs')).href)})`);
}
try {
  await fs.mkdir(project, { recursive: true });
  for (let n = 0; n < cwds.length; n++) {
    await fs.mkdir(cwds[n], { recursive: true });
    await fs.writeFile(path.join(project, `${uuid(n)}.jsonl`), rows(cwds[n], `main-${n}`));
    const children = path.join(project, uuid(n), 'subagents');
    const workflow = path.join(children, 'workflows', 'fixture');
    await fs.mkdir(workflow, { recursive: true });
    for (let k = 0; k < 40; k++) {
      const directory = k < 20 ? children : workflow;
      await fs.writeFile(path.join(directory, `agent-${n}-${k}.jsonl`), rows(cwds[n], `child-${n}-${k}`));
    }
  }
  const modules = {};
  for (const [name, text] of Object.entries({ current, candidate })) {
    const modulePath = path.join(temp, `${name}.mjs`);
    await fs.writeFile(modulePath, absoluteImports(text));
    modules[name] = (await import(pathToFileURL(modulePath))).createClaudeBackend;
  }
  function make(name) {
    const counts = { readdir: 0, realpath: 0, stat: 0, readFile: 0 };
    const fileSystem = { ...fs };
    for (const op of Object.keys(counts)) fileSystem[op] = (...args) => { counts[op]++; return fs[op](...args); };
    const backend = modules[name]({ projectsRoot: root, fileSystem, sessionStore: { getBinding: async () => null } });
    return { backend, counts };
  }
  async function measure(instance) {
    for (const op of Object.keys(instance.counts)) instance.counts[op] = 0;
    const start = performance.now();
    const results = Array(25);
    let next = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < 25) {
        const i = next++;
        results[i] = await instance.backend.listSessions({ cwd: cwds[i], limit: 5, includeSubagents: false });
      }
    }));
    return { seconds: (performance.now() - start) / 1000, counts: { ...instance.counts }, results };
  }
  const coldInstances = { current: make('current'), candidate: make('candidate') };
  const cold = {};
  for (const name of ['current', 'candidate']) cold[name] = await measure(coldInstances[name]);
  assert.deepEqual(cold.candidate.results, cold.current.results);
  const rounds = [];
  let last;
  for (let round = 0; round < 5; round++) {
    const pair = { current: make('current'), candidate: make('candidate') };
    for (const name of ['current', 'candidate']) {
      await pair[name].backend.listSessionsForDirectories({ cwds, includeSubagents: false });
    }
    const run = {};
    for (const name of (round % 2 ? ['candidate', 'current'] : ['current', 'candidate'])) run[name] = await measure(pair[name]);
    assert.deepEqual(run.candidate.results, run.current.results);
    assert.equal(run.current.results.flatMap((page) => page.sessions).length, 25);
    rounds.push(Object.fromEntries(Object.entries(run).map(([name, result]) => [name, { seconds: result.seconds, counts: result.counts }])));
    last = pair;
  }
  const childOptions = { cwds, includeSubagents: true };
  const originalAll = await last.current.backend.listSessionsForDirectories(childOptions);
  const candidateAll = await last.candidate.backend.listSessionsForDirectories(childOptions);
  assert.deepEqual(candidateAll, originalAll);
  assert.equal(candidateAll.groups.flatMap((g) => g.sessions).length, 1025);
  const historyOptions = { sessionRef: { backendId: 'claude', nativeSessionId: 'agent-0-0' }, limit: 10 };
  const history = await last.candidate.backend.readHistory(historyOptions);
  assert.deepEqual(history, await last.current.backend.readHistory(historyOptions));
  assert.equal(history.items[0].content[0].text, 'child-0-0');
  const currentPath = path.join(project, `${uuid(0)}.jsonl`);
  const addedPath = path.join(project, `${uuid(100)}.jsonl`);
  await fs.writeFile(addedPath, rows(cwds[0], 'added'));
  await fs.writeFile(currentPath, rows(cwds[0], 'updated main with a different size'));
  for (const name of ['current', 'candidate']) {
    const page = await last[name].backend.listSessions({ cwd: cwds[0], limit: 5, includeSubagents: false });
    assert.deepEqual(page.sessions.map((s) => s.title).sort(), ['added', 'updated main with a different size']);
  }
  await fs.unlink(currentPath);
  const afterDelete = {};
  for (const name of ['current', 'candidate']) afterDelete[name] = await last[name].backend.listSessions({ cwd: cwds[0], limit: 5, includeSubagents: false });
  assert.deepEqual(afterDelete.current, afterDelete.candidate);
  assert.equal(afterDelete.candidate.sessions.length, 1);
  assert.equal(afterDelete.candidate.sessions[0].title, 'added');
  const stats = (name) => {
    const values = rounds.map((r) => r[name].seconds).sort((a, b) => a - b);
    return { medianSeconds: values[2], minSeconds: values[0], maxSeconds: values[4], ioCountsPerRound: rounds[0][name].counts };
  };
  const summary = { current: stats('current'), candidate: stats('candidate') };
  console.log(JSON.stringify({ benchmark: 'Claude main-only catalogue traversal', fixture: { main: 25, children: 1000, cwds: 25, concurrency: 2 }, coldSingleRun: Object.fromEntries(Object.entries(cold).map(([name, r]) => [name, { seconds: r.seconds, counts: r.counts }])), warmRounds: rounds, warmSummary: summary, savedSeconds: summary.current.medianSeconds - summary.candidate.medianSeconds, verified: ['deep-equal main listings in all rounds', 'includeSubagents=true returns all 1025', 'child readHistory unchanged', 'new/updated/deleted main sessions reflected'], limits: ['synthetic fixtures only', 'no real app/network startup measurement', 'cold means new backend cache, not OS cache', '5000-entry boundary and concurrent write races untested'] }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
