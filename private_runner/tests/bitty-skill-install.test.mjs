import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
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
  // Isolate the checkout so testing live edits cannot modify the real skill.
  const checkout = path.join(home, 'repository');
  const source = path.join(checkout, 'skills', name);
  const installer = path.join(checkout, 'scripts/skills/install-bitty-session.mjs');
  await fs.mkdir(path.dirname(installer), { recursive: true });
  await fs.copyFile(script, installer);
  await fs.cp(path.join(repoRoot, 'skills', name), source, { recursive: true });
  const root = path.join(home, `.${target}`, 'skills', name);
  const run = async (...args) => {
    try { return { code: 0, ...await execFile(process.execPath, [installer, '--target', target, '--home', home, ...args]) }; }
    catch (error) { return error; }
  };
  return { home, root, source, run };
}

for (const target of ['codex', 'claude']) test(`${target} dry-run writes nothing, apply links the canonical skill, and source edits are visible without reinstalling`, async t => {
  const f = await fixture(t, target);
  const dry = await f.run(); assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
  await assert.rejects(fs.stat(path.join(f.home, `.${target}`)), { code: 'ENOENT' });
  const applied = await f.run('--apply'); assert.equal(applied.code, 0);
  assert.equal((await fs.lstat(f.root)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(f.root), await fs.realpath(f.source));
  assert.equal(JSON.parse(applied.stdout).source, await fs.realpath(f.source));
  assert.equal(JSON.parse(applied.stdout).version, JSON.parse(dry.stdout).version);
  await fs.writeFile(path.join(f.source, 'SKILL.md'), 'updated original');
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'updated original');
  assert.equal(JSON.parse((await f.run()).stdout).unchanged, true);
  assert.equal(JSON.parse((await f.run('--apply')).stdout).unchanged, true);
  assert.deepEqual(await fs.readdir(path.dirname(f.root)), [name]);
  await assert.rejects(fs.stat(path.join(f.source, marker)), { code: 'ENOENT' });
});

for (const managed of [false, true]) test(`${managed ? 'legacy managed' : 'unmanaged'} copy requires an exact reviewed digest and is preserved when replaced with a link`, async t => {
  const f = await fixture(t);
  await fs.cp(f.source, f.root, { recursive: true });
  if (managed) {
    const { createHash } = await import('node:crypto');
    const files = { 'SKILL.md': createHash('sha256').update(await fs.readFile(path.join(f.root, 'SKILL.md'))).digest('hex') };
    await fs.writeFile(path.join(f.root, marker), JSON.stringify({ name, files,
      version: createHash('sha256').update(JSON.stringify(files)).digest('hex') }));
  }
  await fs.writeFile(path.join(f.root, 'SKILL.md'), 'my customized local skill');
  await fs.writeFile(path.join(f.root, 'local-notes.txt'), 'unmanaged notes');
  await fs.writeFile(path.join(f.root, '__proto__'), 'local file must survive');
  const unrelated = path.join(path.dirname(f.root), 'unrelated');
  await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'SKILL.md'), 'keep');
  const review = JSON.parse((await f.run()).stdout);
  assert.equal(review.adoptionRequired, true);
  assert.notEqual((await f.run('--apply')).code, 0);
  assert.notEqual((await f.run('--apply', '--adopt-reviewed', '0'.repeat(64))).code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), 'my customized local skill');
  const result = await f.run('--apply', '--adopt-reviewed', review.reviewedDigest);
  assert.equal(result.code, 0);
  const backup = JSON.parse(result.stdout).preservedBackup;
  assert.equal((await fs.lstat(f.root)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'my customized local skill');
  assert.equal(await fs.readFile(path.join(backup, 'local-notes.txt'), 'utf8'), 'unmanaged notes');
  assert.equal(await fs.readFile(path.join(backup, '__proto__'), 'utf8'), 'local file must survive');
  assert.equal(await fs.readFile(path.join(unrelated, 'SKILL.md'), 'utf8'), 'keep');
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

test('target path traversal and symlinks at parents, foreign skill and local payload are refused', async t => {
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

test('a broken skill link is refused without replacing it', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.root), { recursive: true });
  const target = path.join(f.home, 'missing');
  await fs.symlink(target, f.root);
  const result = await f.run('--apply');
  assert.notEqual(result.code, 0); assert.match(result.stderr, /links elsewhere/);
  assert.equal(await fs.readlink(f.root), target);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('an existing relative link to the canonical skill is accepted without replacing it', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.root), { recursive: true });
  const target = path.relative(path.dirname(f.root), f.source);
  await fs.symlink(target, f.root);
  assert.equal(JSON.parse((await f.run('--apply')).stdout).unchanged, true);
  assert.equal(await fs.readlink(f.root), target);
  assert.notEqual((await f.run('--apply', '--adopt-reviewed', '0'.repeat(64))).code, 0);
});

test('unexpected source files and source payload symlinks are refused before installation', async t => {
  const f = await fixture(t);
  const secret = path.join(f.source, 'secret.txt');
  await fs.writeFile(secret, 'must not be exposed');
  assert.notEqual((await f.run('--apply')).code, 0);
  await fs.unlink(secret);
  await fs.unlink(path.join(f.source, 'SKILL.md'));
  await fs.symlink(path.join(f.home, 'outside'), path.join(f.source, 'SKILL.md'));
  assert.notEqual((await f.run('--apply')).code, 0);
  await assert.rejects(fs.lstat(f.root), { code: 'ENOENT' });
});

test('an existing file at the installation path is preserved', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.root), { recursive: true });
  await fs.writeFile(f.root, 'keep');
  assert.notEqual((await f.run('--apply')).code, 0);
  assert.equal(await fs.readFile(f.root, 'utf8'), 'keep');
});


test('installed CLI keeps its control transport and works outside the repository without TCP', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('--apply')).code, 0);
  const dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'installed-ctl-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(await fs.realpath(dir), 'runner.sock');
  const tokenFile = path.join(dir, 'token');
  await fs.writeFile(tokenFile, 'installed-test-token', { mode: 0o600 });
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer installed-test-token');
    response.end(JSON.stringify({ context: 'ctx-test', status: 'ready', epoch: 'epoch', expectedGeneration: 1 }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await execFile(process.execPath, [path.join(f.root, 'scripts/bitty-session.mjs'), 'control', 'status', '--context', 'ctx-test'], {
    cwd: dir, env: { ...process.env, BITTY_REPO_ROOT: '', BITTY_RUNNER_TOKEN_FILE: tokenFile, RUNNER_CONTROL_SOCKET: socketPath,
      BITTY_RUNNER_URL: 'https://must-not-use.example' },
  });
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  assert.equal(requests, 1);
});
