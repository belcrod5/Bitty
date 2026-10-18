#!/usr/bin/env node
// Install this repository's one managed Bitty skill, with review before adopting a local copy.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'bitty-session-orchestrator';
const marker = '.bitty-skill-install.json';
const source = fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const usage = 'node scripts/skills/install-bitty-session.mjs --target codex|claude [--home <directory>] [--apply] [--adopt-reviewed <digest>]';

async function filesAt(root, relative = '') {
  const files = Object.create(null);
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Unsupported link or file: ${rel}`);
    if (entry.isDirectory()) Object.assign(files, await filesAt(root, rel));
    else files[rel] = digest(await fs.readFile(path.join(root, rel)));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function exists(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function safeParents(home, components, create = false) {
  let directory = home;
  for (const component of components) {
    directory = path.join(directory, component);
    const stat = await exists(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Installation path must be a real directory: ${directory}`);
    if (!stat && create) await fs.mkdir(directory, { mode: 0o700 });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return console.log(usage);
  let target, home = os.homedir(), apply = false, reviewed;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--apply' && !apply) { apply = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (flag === '--target' && !target) target = value;
    else if (flag === '--home') home = value;
    else if (flag === '--adopt-reviewed' && !reviewed) reviewed = value;
    else throw new Error(usage);
  }
  if (!['codex', 'claude'].includes(target) || (reviewed && !/^[a-f0-9]{64}$/.test(reviewed))) throw new Error(usage);
  const homeStat = await fs.lstat(path.resolve(home));
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error('--home must be an existing real directory');
  home = await fs.realpath(path.resolve(home));
  const components = [`.${target}`, 'skills'];
  await safeParents(home, [...components, name]);
  const parent = path.join(home, ...components);
  const destination = path.join(parent, name);
  const sourceFiles = await filesAt(source);
  // The shipped payload is intentionally limited; config and authentication files are never copied.
  for (const rel of Object.keys(sourceFiles)) {
    if (!(rel === 'SKILL.md' || rel === 'scripts/bitty-session.mjs' || /^references\/[a-z-]+\.md$/.test(rel))) {
      throw new Error(`Unexpected source file: ${rel}`);
    }
  }
  const version = digest(JSON.stringify(sourceFiles));
  const present = await exists(destination);
  const existing = present ? await filesAt(destination) : {};
  const existingDigest = digest(JSON.stringify(existing));
  let managed = false;
  if (existing[marker]) {
    const state = JSON.parse(await fs.readFile(path.join(destination, marker), 'utf8'));
    if (!state || state.name !== name || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)
      || state.version !== digest(JSON.stringify(state.files))) throw new Error('Invalid installed manifest; preserve and review the local copy');
    const actual = { ...existing }; delete actual[marker];
    if (JSON.stringify(actual) !== JSON.stringify(state.files)) throw new Error('Installed skill has local changes; preserve and review them before syncing');
    managed = true;
  }
  const changes = [...new Set([...Object.keys(existing).filter(rel => rel !== marker), ...Object.keys(sourceFiles)])]
    .filter(rel => existing[rel] !== sourceFiles[rel])
    .map(rel => ({ path: rel, change: !existing[rel] ? 'add' : !sourceFiles[rel] ? 'remove' : 'update' }));
  const adoptionRequired = Boolean(present && !managed);
  const report = { target, destination, version, mode: apply ? 'apply' : 'dry-run', changes, adoptionRequired,
    ...(adoptionRequired ? { reviewedDigest: existingDigest } : {}) };
  if (!apply) return console.log(JSON.stringify(report));
  if (adoptionRequired && reviewed !== existingDigest) throw new Error('Unmanaged installed skill: inspect dry-run changes, then use --adopt-reviewed with that exact digest; the original will be preserved as a backup');
  if (!adoptionRequired && reviewed) throw new Error('--adopt-reviewed is only for an unmanaged installation');
  if (managed && changes.length === 0) return console.log(JSON.stringify({ ...report, unchanged: true }));
  await safeParents(home, components, true);
  const stage = await fs.mkdtemp(path.join(parent, `.${name}.stage-`));
  let backup;
  try {
    for (const rel of Object.keys(sourceFiles)) {
      const file = path.join(stage, rel);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, await fs.readFile(path.join(source, rel)), { mode: rel.endsWith('.mjs') ? 0o755 : 0o644, flag: 'wx' });
    }
    await fs.writeFile(path.join(stage, marker), `${JSON.stringify({ name, version, files: sourceFiles })}\n`, { mode: 0o600, flag: 'wx' });
    await safeParents(home, [...components, name]);
    if (present) {
      if (JSON.stringify(await filesAt(destination)) !== JSON.stringify(existing)) throw new Error('Installed skill changed during review; rerun dry-run');
      backup = path.join(parent, `.${name}.backup-${randomUUID()}`);
      await fs.rename(destination, backup);
    } else if (await exists(destination)) throw new Error('Installation appeared during review; rerun dry-run');
    try { await fs.rename(stage, destination); }
    catch (error) { if (backup) await fs.rename(backup, destination); throw error; }
    // Keep adopted local contents. A verified managed backup contains only our previous payload.
    if (backup && managed) await fs.rm(backup, { recursive: true });
    console.log(JSON.stringify({ ...report, ...(backup && !managed ? { preservedBackup: backup } : {}) }));
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
