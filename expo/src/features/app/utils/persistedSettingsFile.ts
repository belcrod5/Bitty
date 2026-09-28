import * as FileSystem from "expo-file-system/legacy";

// Single source of truth for the on-disk app-settings file name. Written (debounced) by
// useAppSettingsPersistenceController.ts via AppRoot.tsx and read directly from disk by
// background-safe code paths (e.g. pushApprovalActions.ts) that can run before the React
// provider tree has loaded settings into context.
const SETTINGS_FILE_NAME = "bitty-settings.json";
let settingsMutationQueue: Promise<unknown> = Promise.resolve();

function settingsPaths() {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) throw new Error("Persistent settings directory is unavailable");
  const path = `${baseDir}${SETTINGS_FILE_NAME}`;
  return { path, pendingPath: `${path}.pending` };
}

async function readSettingsAtPath(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return undefined;
  const parsed = JSON.parse(await FileSystem.readAsStringAsync(path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid settings file: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

async function readPersistedSettingsWithoutBarrier() {
  const paths = settingsPaths();
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
    const current = await readPersistedSettingsWithoutBarrier() ?? {};
    await FileSystem.writeAsStringAsync(paths.pendingPath, JSON.stringify(mutate(current)));
    await FileSystem.moveAsync({ from: paths.pendingPath, to: paths.path });
  });
  settingsMutationQueue = operation.catch(() => {});
  await operation;
}

// Freeze the endpoints that belonged to the device data before runnerUrl can be
// rewritten by automatic local/Cloudflare route selection or settings autosave.
export const LEGACY_RUNNER_URLS_FIELD = "legacyRunnerUrls";

export function configuredRunnerUrls(settings: Record<string, unknown>): string[] {
  const urls = [settings.runnerUrl, settings.localRunnerUrl, settings.cloudflareRunnerUrl]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter((value) => /^https?:\/\//.test(value));
  return [...new Set(urls)];
}

export function legacyRunnerUrls(settings: Record<string, unknown> | undefined): string[] {
  const urls = settings?.[LEGACY_RUNNER_URLS_FIELD];
  return Array.isArray(urls) ? urls.filter((value): value is string => typeof value === "string") : [];
}

export async function freezeLegacyRunnerUrls() {
  await mutatePersistedSettings((current) => Object.prototype.hasOwnProperty.call(current, LEGACY_RUNNER_URLS_FIELD)
    ? current
    : { ...current, [LEGACY_RUNNER_URLS_FIELD]: configuredRunnerUrls(current) });
}

export const LOCATION_BACKGROUND_FIELDS = [
  "locationSchedules",
  "locationScheduleMigrationComplete",
  "locationScheduleRunnerUrls",
  "locationSchedulePendingStates",
  "locationScheduleLastStates",
] as const;

// Skiaボードの文字倍率(端末ローカル設定。ランナー共有ボードには含めない)。
// ボード配置自体の正本はランナーが持ち、端末には保存しない(旧skiaBoardState
// フィールドはPRESERVED対象から外れたため、次の設定保存で自然に消える)。
export const SKIA_BOARD_CARD_TEXT_SCALE_FIELD = "skiaBoardCardTextScale";

// ランナー正本ボードの読み取り専用キャッシュ(オフライン起動時の表示用)。
export const SKIA_BOARD_RUNNER_CACHE_FIELD = "skiaBoardRunnerCache";

// ボード配置とは独立した端末固有の表示位置・倍率。
export const SKIA_BOARD_VIEWPORT_FIELD = "skiaBoardViewport";

// 旧バージョンの端末保存フィールド。Runnerへの一度限りの移行に使用する。
export const COMPOSER_MESSAGE_HISTORY_FIELD = "composerMessageHistory";

// 旧バージョンの未送信入力。移行成功後は端末から削除する。
export const COMPOSER_DRAFTS_FIELD = "composerDrafts";

// React側の設定stateから再構築されず、所有者(バックグラウンド位置タスク・Skiaボード)が
// mutatePersistedSettingsで直接書くフィールド。設定オートセーブは値を保持する。
export const PRESERVED_SETTINGS_FIELDS = [
  ...LOCATION_BACKGROUND_FIELDS,
  LEGACY_RUNNER_URLS_FIELD,
  // Retain old shared fields until the Runner confirms a successful migration.
  "registeredDirectories",
  "sessionTitleOverridesById",
  "sessionMarkerColorsById",
  SKIA_BOARD_CARD_TEXT_SCALE_FIELD,
  SKIA_BOARD_RUNNER_CACHE_FIELD,
  SKIA_BOARD_VIEWPORT_FIELD,
  COMPOSER_MESSAGE_HISTORY_FIELD,
  COMPOSER_DRAFTS_FIELD,
] as const;

// Reads a single field from the persisted settings JSON without going through React
// context. Returns undefined only when the file is missing. Read and parse failures
// remain errors so callers cannot mistake unavailable persisted data for defaults.
export async function readPersistedSettingsField(field: string): Promise<unknown> {
  return (await readPersistedSettings())?.[field];
}
