import * as FileSystem from "expo-file-system/legacy";

// Single source of truth for the on-disk app-settings file name. Written (debounced) by
// useAppSettingsPersistenceController.ts via AppRoot.tsx and read directly from disk by
// background-safe code paths (e.g. pushApprovalActions.ts) that can run before the React
// provider tree has loaded settings into context.
export const SETTINGS_FILE_NAME = "bitty-settings.json";
let settingsMutationQueue: Promise<unknown> = Promise.resolve();

export async function mutatePersistedSettings(
  mutate: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const operation = settingsMutationQueue.then(async () => {
    const baseDir = FileSystem.documentDirectory;
    if (!baseDir) return;
    const path = `${baseDir}${SETTINGS_FILE_NAME}`;
    let current: Record<string, unknown> = {};
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        const parsed = JSON.parse(await FileSystem.readAsStringAsync(path));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      }
    } catch {}
    await FileSystem.writeAsStringAsync(path, JSON.stringify(mutate(current)));
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
  try {
    const baseDir = FileSystem.documentDirectory;
    if (!baseDir) return undefined;
    const path = `${baseDir}${SETTINGS_FILE_NAME}`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return undefined;
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}
