import path from "node:path";
import { promises as fs } from "node:fs";

export async function removeLegacyLocationStore({ defaultPath, configuredPath, protectedPaths }) {
  const protectedNames = new Set(protectedPaths.map((name) => path.resolve(name)));
  for (const name of protectedPaths) {
    protectedNames.add(await fs.realpath(name).catch(() => path.resolve(name)));
  }

  for (const storePath of new Set([defaultPath, configuredPath].filter(Boolean).map((name) => path.resolve(name)))) {
    const realPath = await fs.realpath(storePath).catch(() => storePath);
    if (protectedNames.has(storePath) || protectedNames.has(realPath)) continue;

    const basename = path.basename(storePath);
    const isDedicatedName = basename === "location_schedules.json";
    let isLocationStore = isDedicatedName;
    if (!isLocationStore) {
      try {
        const value = JSON.parse(await fs.readFile(storePath, "utf8"));
        isLocationStore = value?.version === 1
          && (Number.isSafeInteger(value.scheduleRevision) || typeof value.updatedAt === "string")
          && typeof value.phoneTimeZone === "string"
          && Array.isArray(value.rules)
          && value.states && typeof value.states === "object"
          && value.occurrences && typeof value.occurrences === "object";
      } catch {
        // An arbitrary configured path is never deleted unless it is recognizably ours.
      }
    }
    if (!isLocationStore) continue;

    const directory = path.dirname(storePath);
    const entries = await fs.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const generatedTemp = entry.startsWith(`${basename}.`) && /^[0-9a-f-]{36}\.tmp$/.test(entry.slice(basename.length + 1));
      const legacyResidue = isDedicatedName && (
        entry === `${basename}.pending`
        || entry.startsWith(`${basename}.corrupt-`)
        || entry.startsWith(`${basename}.backup-`)
        || (entry.startsWith("location_schedules.backup-") && entry.endsWith(".json"))
      );
      if (entry === basename || generatedTemp || legacyResidue) {
        const candidate = path.join(directory, entry);
        const realCandidate = await fs.realpath(candidate).catch(() => candidate);
        if (protectedNames.has(candidate) || protectedNames.has(realCandidate)) continue;
        await fs.rm(candidate, { force: true });
      }
    }
  }
}
