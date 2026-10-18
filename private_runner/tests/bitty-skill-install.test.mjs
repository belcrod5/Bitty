import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFile = promisify(callback);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(repoRoot, 'scripts/skills/install-bitty-session.mjs');
const name = 'bitty-session-orchestrator';
const marker = '.bitty-skill-install.json';
async function fixture(t, target = 'codex') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bitty-skill-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, `.${target}`, 'skills', name);
  const run = async (...args) => {
    try { return { code: 0, ...await execFile(process.execPath, [script, '--target', target, '--home', home, ...args]) }; }
    catch (error) { return error; }
  };
  return { home, root, run };
}

for (const target of ['codex', 'claude']) test(`${target} dry-run writes nothing, apply installs exactly the canonical skill, sync is idempotent`, async t => {
  const f = await fixture(t, target);
  const dry = await f.run(); assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
  await assert.rejects(fs.stat(path.join(f.home, `.${target}`)), { code: 'ENOENT' });
  const applied = await f.run('--apply'); assert.equal(applied.code, 0);
  const state = JSON.parse(await fs.readFile(path.join(f.root, marker), 'utf8'));
  assert.equal(state.name, name); assert.equal(state.version, JSON.parse(dry.stdout).version);
  assert.ok(state.files['references/app-control.md']); assert.ok(state.files['scripts/bitty-session.mjs']);
  assert.equal((await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8')), await fs.readFile(path.join(repoRoot, 'skills/bitty-session-orchestrator/SKILL.md'), 'utf8'));
  assert.equal(JSON.parse((await f.run('--apply')).stdout).unchanged, true);
});

test('unmanaged copy is never overwritten without exact reviewed digest, and adoption preserves original contents', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, { recursive: true }); await fs.writeFile(path.join(f.root, 'SKILL.md'), 'my customized local skill');
  await fs.writeFile(path.join(f.root, 'local-notes.txt'), 'unmanaged notes');
  const review = JSON.parse((await f.run()).stdout);
  assert.equal(review.adoptionRequired, true);
  assert.notEqual((await f.run('--apply')).code, 0);
  assert.notEqual((await f.run('--apply', '--adopt-reviewed', '0'.repeat(64))).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'my customized local skill');
  const result = await f.run('--apply', '--adopt-reviewed', review.reviewedDigest);
  assert.equal(result.code, 0);
  const backup = JSON.parse(result.stdout).preservedBackup;
  assert.equal(await fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'my customized local skill');
  assert.equal(await fs.readFile(path.join(backup, 'local-notes.txt'), 'utf8'), 'unmanaged notes');
  await assert.rejects(fs.stat(path.join(f.root, 'local-notes.txt')), { code: 'ENOENT' });
});

test('review digest becomes stale after local edits', async t => {
  const f = await fixture(t); await fs.mkdir(f.root, { recursive: true });
  await fs.writeFile(path.join(f.root, 'SKILL.md'), 'before');
  const review = JSON.parse((await f.run()).stdout);
  await fs.writeFile(path.join(f.root, 'SKILL.md'), 'after');
  assert.notEqual((await f.run('--apply', '--adopt-reviewed', review.reviewedDigest)).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'after');
});

test('managed local changes and extra files block sync rather than being deleted', async t => {
  const f = await fixture(t); assert.equal((await f.run('--apply')).code, 0);
  await fs.writeFile(path.join(f.root, 'references/app-control.md'), 'custom change');
  assert.notEqual((await f.run('--apply')).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'references/app-control.md'), 'utf8'), 'custom change');
});

test('outdated but unmodified managed installation upgrades without losing unrelated skills', async t => {
  const f = await fixture(t); assert.equal((await f.run('--apply')).code, 0);
  const unrelated = path.join(path.dirname(f.root), 'unrelated'); await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'SKILL.md'), 'keep');
  // Make a valid older managed state, independent of how the current payload is written.
  const { createHash } = await import('node:crypto'); const hash = value => createHash('sha256').update(value).digest('hex');
  const state = JSON.parse(await fs.readFile(path.join(f.root, marker), 'utf8'));
  await fs.writeFile(path.join(f.root, 'SKILL.md'), 'old shipped version');
  state.files['SKILL.md'] = hash('old shipped version'); state.version = hash(JSON.stringify(state.files));
  await fs.writeFile(path.join(f.root, marker), JSON.stringify(state));
  assert.equal((await f.run('--apply')).code, 0);
  assert.equal(await fs.readFile(path.join(unrelated, 'SKILL.md'), 'utf8'), 'keep');
  assert.notEqual(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'old shipped version');
});

test('target path traversal and symlinks at parent, skill and payload are refused', async t => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.home, '.codex'));
  assert.notEqual((await f.run('--apply')).code, 0);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.home, '.codex'));
  await fs.mkdir(path.dirname(f.root), { recursive: true }); await fs.symlink(outside, f.root);
  assert.notEqual((await f.run('--apply')).code, 0);
  await fs.unlink(f.root); await fs.mkdir(f.root); await fs.symlink(path.join(outside, 'secret'), path.join(f.root, 'SKILL.md'));
  assert.notEqual((await f.run('--apply')).code, 0);
  await assert.rejects(execFile(process.execPath, [script, '--target', '../elsewhere', '--home', f.home, '--apply']));
});

test('managed upgrade detects and preserves a local __proto__ file', async t => {
  const f = await fixture(t); assert.equal((await f.run('--apply')).code, 0);
  const { createHash } = await import('node:crypto');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const state = JSON.parse(await fs.readFile(path.join(f.root, marker), 'utf8'));
  await fs.writeFile(path.join(f.root, 'SKILL.md'), 'old shipped version');
  state.files['SKILL.md'] = hash('old shipped version');
  state.version = hash(JSON.stringify(state.files));
  await fs.writeFile(path.join(f.root, marker), JSON.stringify(state));
  await fs.writeFile(path.join(f.root, '__proto__'), 'local file must survive');
  const result = await f.run('--apply');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /local changes/);
  assert.equal(await fs.readFile(path.join(f.root, '__proto__'), 'utf8'), 'local file must survive');
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'old shipped version');
});
