#!/usr/bin/env node
// Link this repository's Bitty skill, preserving reviewed local copies as backups.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'bitty-session-orchestrator';
const marker = '.bitty-skill-install.json';
const source = await fs.realpath(fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url)));
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
  await safeParents(home, components);
  const parent = path.join(home, ...components);
  const destination = path.join(parent, name);
  const sourceFiles = await filesAt(source);
  // Only the skill payload may be exposed through the link.
  for (const rel of Object.keys(sourceFiles)) {
    if (!(rel === 'SKILL.md' || ['scripts/bitty-session.mjs', 'scripts/runner-control.mjs'].includes(rel) || /^references\/[a-z-]+\.md$/.test(rel))) {
      throw new Error(`Unexpected source file: ${rel}`);
    }
  }
  const version = digest(JSON.stringify(sourceFiles));
  const present = await exists(destination);
  if (present?.isSymbolicLink()) {
    const linkedSource = await fs.realpath(destination).catch(() => null);
    if (linkedSource !== source) throw new Error(`Installed skill links elsewhere; preserve and review it manually: ${destination}`);
    if (reviewed) throw new Error('--adopt-reviewed is only for an existing local copy');
    return console.log(JSON.stringify({ target, destination, source, version, mode: apply ? 'apply' : 'dry-run',
      changes: [], adoptionRequired: false, unchanged: true }));
  }
  if (present && !present.isDirectory()) throw new Error(`Installed skill must be a directory or the canonical link: ${destination}`);
  const existing = present ? await filesAt(destination) : {};
  const existingDigest = digest(JSON.stringify(existing));
  const changes = [...new Set([...Object.keys(existing).filter(rel => rel !== marker), ...Object.keys(sourceFiles)])]
    .filter(rel => existing[rel] !== sourceFiles[rel])
    .map(rel => ({ path: rel, change: !existing[rel] ? 'add' : !sourceFiles[rel] ? 'remove' : 'update' }));
  const adoptionRequired = Boolean(present);
  const report = { target, destination, source, version, mode: apply ? 'apply' : 'dry-run', changes, adoptionRequired,
    ...(adoptionRequired ? { reviewedDigest: existingDigest } : {}) };
  if (!apply) return console.log(JSON.stringify(report));
  if (adoptionRequired && reviewed !== existingDigest) throw new Error('Existing local copy: inspect dry-run changes, then use --adopt-reviewed with that exact digest; the original will be preserved as a backup');
  if (!adoptionRequired && reviewed) throw new Error('--adopt-reviewed is only for an existing local copy');
  await safeParents(home, components, true);
  let backup;
  if (present) {
    const current = await exists(destination);
    if (!current?.isDirectory() || JSON.stringify(await filesAt(destination)) !== JSON.stringify(existing)) {
      throw new Error('Installed skill changed during review; rerun dry-run');
    }
    backup = path.join(parent, `.${name}.backup-${randomUUID()}`);
    await fs.rename(destination, backup);
  }
  try { await fs.symlink(source, destination, 'dir'); }
  catch (error) {
    if (backup) {
      if (!await exists(destination)) await fs.rename(backup, destination);
      else error.message += `; original copy preserved at ${backup}`;
    }
    throw error;
  }
  console.log(JSON.stringify({ ...report, ...(backup ? { preservedBackup: backup } : {}) }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
