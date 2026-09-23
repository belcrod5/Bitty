import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import test from "node:test";
import { createGoogleCloudUsageLedger } from "../src/google-cloud-usage.mjs";

async function ledgerFixture(now = () => new Date("2026-09-23T00:00:00.000Z"), getLimitMinutes = () => 60) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-google-usage-"));
  const filePath = path.join(root, "private", "usage.json");
  return { root, filePath, ledger: createGoogleCloudUsageLedger({ filePath, now, getLimitMinutes }) };
}

test("usage reservations are atomic, restrictive, and capped across concurrent streams", async (t) => {
  const fixture = await ledgerFixture(undefined, () => 1);
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const initial = await fixture.ledger.get("valid-project-123");
  assert.deepEqual(initial, {
    projectId: "valid-project-123",
    monthUtc: "2026-09",
    usedSeconds: 0,
    limitSeconds: 60,
    remainingSeconds: 60,
    resetAt: "2026-10-01T00:00:00.000Z",
  });

  const reservations = await Promise.all([
    fixture.ledger.reserve("valid-project-123", 40),
    fixture.ledger.reserve("valid-project-123", 40),
  ]);
  assert.equal(reservations.filter((item) => item.reserved).length, 1);
  assert.equal(reservations.filter((item) => !item.reserved).length, 1);
  assert.equal((await fixture.ledger.get("valid-project-123")).usedSeconds, 40);
  assert.equal((await fs.stat(fixture.filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(fixture.filePath))).mode & 0o777, 0o700);
});

test("a lower configured limit applies to the next reservation on an active project", async (t) => {
  let limitMinutes = 2;
  const fixture = await ledgerFixture(undefined, () => limitMinutes);
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  assert.equal((await fixture.ledger.reserve("valid-project-123", 61)).reserved, true);
  limitMinutes = 1;
  const denied = await fixture.ledger.reserve("valid-project-123", 1);
  assert.equal(denied.reserved, false);
  assert.equal(denied.usedSeconds, 61);
  assert.equal(denied.limitSeconds, 60);
  assert.equal((await fixture.ledger.get("valid-project-123")).limitSeconds, 60);
});

test("usage ledger retains prior UTC months", async (t) => {
  let current = new Date("2026-09-30T23:59:59.000Z");
  const fixture = await ledgerFixture(() => current);
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fixture.ledger.reserve("valid-project-123", 3);
  current = new Date("2026-10-01T00:00:00.000Z");
  assert.equal((await fixture.ledger.get("valid-project-123")).usedSeconds, 0);
  const stored = JSON.parse(await fs.readFile(fixture.filePath, "utf8"));
  assert.equal(stored.projects["valid-project-123"].months["2026-09"].usedSeconds, 3);
  assert.equal(stored.projects["valid-project-123"].months["2026-10"].usedSeconds, 0);
});

test("usage ledger fails closed for corrupt, permissive, or symlinked state", async (t) => {
  const fixture = await ledgerFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fixture.filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(fixture.filePath, "not-json", { mode: 0o600 });
  await assert.rejects(fixture.ledger.get("valid-project-123"));

  await fs.writeFile(fixture.filePath, JSON.stringify({ version: 1, projects: {} }), { mode: 0o600 });
  await fs.chmod(fixture.filePath, 0o644);
  await assert.rejects(fixture.ledger.get("valid-project-123"), /permissions must be 600/);

  const target = path.join(fixture.root, "target.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, projects: {} }), { mode: 0o600 });
  await fs.unlink(fixture.filePath);
  await fs.symlink(target, fixture.filePath);
  await assert.rejects(fixture.ledger.get("valid-project-123"), /regular file/);
});

test("usage ledger rejects array-shaped project, month map, and bucket records", async (t) => {
  for (const projects of [
    { "valid-project-123": [] },
    { "valid-project-123": { months: [] } },
    { "valid-project-123": { months: { "2026-09": [] } } },
  ]) {
    const fixture = await ledgerFixture();
    t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    await fs.mkdir(path.dirname(fixture.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(fixture.filePath, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
    await assert.rejects(fixture.ledger.reserve("valid-project-123", 1), /record|bucket/);
  }
});

test("startup initialization rejects an unsafe existing usage ledger", async (t) => {
  const fixture = await ledgerFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fixture.filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(fixture.filePath, JSON.stringify({ version: 1, projects: {} }), { mode: 0o644 });
  await assert.rejects(fixture.ledger.initialize(), /permissions must be 600/);
});

test("startup initialization rejects a symlinked usage directory", async (t) => {
  const fixture = await ledgerFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.root, "target");
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.dirname(fixture.filePath));
  await assert.rejects(fixture.ledger.initialize(), /must be a directory/);
});
