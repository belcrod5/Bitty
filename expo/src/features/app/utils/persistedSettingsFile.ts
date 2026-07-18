import * as FileSystem from "expo-file-system/legacy";

// Single source of truth for the on-disk app-settings file name. Written (debounced) by
// useAppSettingsPersistenceController.ts via AppRoot.tsx and read directly from disk by
// background-safe code paths (e.g. pushApprovalActions.ts) that can run before the React
// provider tree has loaded settings into context.
export const SETTINGS_FILE_NAME = "bitty-settings.json";
let settingsMutationQueue: Promise<unknown> = Promise.resolve();

function settingsPaths() {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) return null;
  const path = `${baseDir}${SETTINGS_FILE_NAME}`;
  return { path, pendingPath: `${path}.pending` };
}

async function readSettingsAtPath(path: string) {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return undefined;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function readPersistedSettingsWithoutBarrier() {
  const paths = settingsPaths();
  if (!paths) return undefined;
  const pending = await readSettingsAtPath(paths.pendingPath);
  if (pending) return pending;
  const persisted = await readSettingsAtPath(paths.path);
  if (persisted) return persisted;
  // Native moveAsync replaces the destination by removing it immediately before
  // moving the complete pending file. Retry once if this read landed in that gap.
  return readSettingsAtPath(paths.path);
}

export async function readPersistedSettings() {
  await settingsMutationQueue;
  return readPersistedSettingsWithoutBarrier();
}

export async function mutatePersistedSettings(
  mutate: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const operation = settingsMutationQueue.then(async () => {
    const paths = settingsPaths();
    if (!paths) return;
    const current = await readPersistedSettingsWithoutBarrier() ?? {};
    await FileSystem.writeAsStringAsync(paths.pendingPath, JSON.stringify(mutate(current)));
    await FileSystem.moveAsync({ from: paths.pendingPath, to: paths.path });
  });
  settingsMutationQueue = operation.catch(() => {});
  await operation;
}

export const LOCATION_BACKGROUND_FIELDS = [
  "locationSchedules",
  "locationSchedulePendingStates",
  "locationScheduleLastStates",
] as const;

// Reads a single field from the persisted settings JSON without going through React
// context. Returns undefined when the file is missing/unreadable/malformed so callers
// can apply their own defaults.
export async function readPersistedSettingsField(field: string): Promise<unknown> {
  return (await readPersistedSettings())?.[field];
}
