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

export const LOCATION_BACKGROUND_FIELDS = [
  "locationSchedules",
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

// 送信履歴は設定stateではなく、送信acceptance境界が直接所有する端末ローカルデータ。
export const COMPOSER_MESSAGE_HISTORY_FIELD = "composerMessageHistory";

// 未送信入力はセッション単位で端末だけに保持する。
export const COMPOSER_DRAFTS_FIELD = "composerDrafts";

// React側の設定stateから再構築されず、所有者(バックグラウンド位置タスク・Skiaボード)が
// mutatePersistedSettingsで直接書くフィールド。設定オートセーブは値を保持する。
export const PRESERVED_SETTINGS_FIELDS = [
  ...LOCATION_BACKGROUND_FIELDS,
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
