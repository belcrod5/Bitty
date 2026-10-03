import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeLegacyLocationStore } from "../src/remove-legacy-location-store.mjs";

test("removes only location store data and its old write residues", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "location-store-removal-"));
  try {
    const location = path.join(root, "location_schedules.json");
    const codex = path.join(root, "codex_schedules.json");
    const runtime = path.join(root, "codex_schedule_runtime.json");
    const residue = [
      location,
      `${location}.pending`,
      `${location}.corrupt-2026`,
      `${location}.backup-old`,
      `${location}.12345678-1234-1234-1234-123456789abc.tmp`,
      path.join(root, "location_schedules.backup-old.json"),
    ];
    await Promise.all(residue.map((name) => fs.writeFile(name, "old location data")));
    await fs.writeFile(codex, "codex definitions");
    await fs.writeFile(runtime, "codex runtime");
    await fs.writeFile(path.join(root, "other.json"), "other settings");

    const options = { defaultPath: location, configuredPath: codex, protectedPaths: [codex, runtime] };
    await removeLegacyLocationStore(options);
    await removeLegacyLocationStore(options);

    for (const name of residue) await assert.rejects(fs.access(name), { code: "ENOENT" });
    assert.equal(await fs.readFile(codex, "utf8"), "codex definitions");
    assert.equal(await fs.readFile(runtime, "utf8"), "codex runtime");
    assert.equal(await fs.readFile(path.join(root, "other.json"), "utf8"), "other settings");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("custom path is removed only when it contains a location store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "location-custom-removal-"));
  try {
    const custom = path.join(root, "custom.json");
    const ordinary = path.join(root, "ordinary.json");
    const options = { defaultPath: path.join(root, "location_schedules.json"), configuredPath: custom, protectedPaths: [ordinary] };
    await fs.writeFile(custom, JSON.stringify({ version: 1, scheduleRevision: 1, phoneTimeZone: "UTC", rules: [], states: {}, occurrences: {} }));
    await fs.writeFile(`${custom}.12345678-1234-1234-1234-123456789abc.tmp`, "old temp");
    await fs.writeFile(ordinary, JSON.stringify({ version: 1, rules: [] }));
    await removeLegacyLocationStore(options);
    await assert.rejects(fs.access(custom), { code: "ENOENT" });
    await assert.rejects(fs.access(`${custom}.12345678-1234-1234-1234-123456789abc.tmp`), { code: "ENOENT" });
    assert.ok(await fs.readFile(ordinary, "utf8"));

    await fs.writeFile(custom, "corrupt unrelated data");
    await removeLegacyLocationStore(options);
    assert.equal(await fs.readFile(custom, "utf8"), "corrupt unrelated data");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("protected schedule paths are preserved even when named like location residues", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "location-protected-residue-"));
  try {
    const location = path.join(root, "location_schedules.json");
    const protectedResidue = `${location}.pending`;
    const codex = path.join(root, "codex_schedules.json");
    const linkedResidue = `${location}.corrupt-old`;
    await fs.writeFile(location, "old location data");
    await fs.writeFile(protectedResidue, "schedule data");
    await fs.writeFile(codex, "runtime data");
    await fs.symlink(codex, linkedResidue);
    await removeLegacyLocationStore({
      defaultPath: location,
      protectedPaths: [protectedResidue, codex],
    });
    await assert.rejects(fs.access(location), { code: "ENOENT" });
    assert.equal(await fs.readFile(protectedResidue, "utf8"), "schedule data");
    assert.equal(await fs.readFile(linkedResidue, "utf8"), "runtime data");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
