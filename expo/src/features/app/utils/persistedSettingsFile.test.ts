const mockFiles = new Map<string, string>();
let mockDocumentDirectory: string | null = "file:///documents/";
let mockReadError: Error | null = null;
let mockMoveBarrier: Promise<void> | null = null;
let mockWriteStarted: Promise<void>;
let resolveMockWriteStarted: () => void;
const mockWriteAsStringAsync = jest.fn(async (path: string, value: string) => {
  mockFiles.set(path, value);
  resolveMockWriteStarted();
});
const mockMoveAsync = jest.fn(async ({ from, to }: { from: string; to: string }) => {
  await mockMoveBarrier;
  const value = mockFiles.get(from);
  mockFiles.delete(to);
  if (typeof value !== "undefined") mockFiles.set(to, value);
  mockFiles.delete(from);
});

jest.mock("expo-file-system/legacy", () => ({
  get documentDirectory() {
    return mockDocumentDirectory;
  },
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  readAsStringAsync: jest.fn(async (path: string) => {
    if (mockReadError) throw mockReadError;
    const value = mockFiles.get(path);
    if (typeof value === "undefined") throw new Error("missing");
    return value;
  }),
  writeAsStringAsync: (...args: [string, string]) => mockWriteAsStringAsync(...args),
  moveAsync: (...args: [{ from: string; to: string }]) => mockMoveAsync(...args),
}));

import {
  mutatePersistedSettings,
  PRESERVED_SETTINGS_FIELDS,
  readPersistedSettings,
  readPersistedSettingsField,
  SKIA_BOARD_VIEWPORT_FIELD,
} from "./persistedSettingsFile";

// ボード配置の正本はランナーへ移行済み。旧skiaBoardStateをPRESERVEDへ戻すと
// 端末に配置データが残り続けるため、実定数から外れていることを固定する。
test("preserved settings fields no longer carry the legacy skia board state", () => {
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("skiaBoardState");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("composerMessageHistory");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("composerDrafts");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("registeredDirectories");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("sessionTitleOverridesById");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("sessionMarkerColorsById");
  expect(PRESERVED_SETTINGS_FIELDS).not.toContain("locationSchedules");
  expect(PRESERVED_SETTINGS_FIELDS).toContain(SKIA_BOARD_VIEWPORT_FIELD);
});

beforeEach(() => {
  mockFiles.clear();
  mockDocumentDirectory = "file:///documents/";
  mockReadError = null;
  mockMoveBarrier = null;
  mockWriteStarted = new Promise<void>((resolve) => { resolveMockWriteStarted = resolve; });
  jest.clearAllMocks();
});

test("distinguishes an unreadable settings file from a missing file", async () => {
  mockFiles.set("file:///documents/bitty-settings.json", "{}");
  mockReadError = new Error("settings file temporarily unavailable");

  await expect(readPersistedSettings()).rejects.toThrow("settings file temporarily unavailable");
});

test("returns undefined when no settings file exists", async () => {
  await expect(readPersistedSettings()).resolves.toBeUndefined();
});

test("reports an unavailable persistence directory instead of silently dropping writes", async () => {
  mockDocumentDirectory = null;
  await expect(mutatePersistedSettings(() => ({ runnerUrl: "http://runner" })))
    .rejects.toThrow("Persistent settings directory is unavailable");
});

test("serializes writes while removing obsolete settings and preserving other data", async () => {
  mockFiles.set("file:///documents/bitty-settings.json", JSON.stringify({
    faceTrackingEnabled: true,
    faceIdRequiredForApproval: true,
  }));
  await Promise.all([
    mutatePersistedSettings((current) => ({ ...current, runnerUrl: "http://runner" })),
    mutatePersistedSettings((current) => ({
      ...current,
      skiaBoardViewport: { x: 1 },
      locationSchedules: [{ id: "office" }],
      locationScheduleRunnerUrls: ["https://old-runner"],
      locationScheduleRunnerTokenId: "old-token",
      locationSchedulePendingStates: [{ eventId: "outside" }],
      locationScheduleLastStates: { office: "inside" },
      locationScheduleArchivedByRunner: { old: true },
    })),
  ]);

  expect(await readPersistedSettings()).toEqual({
    runnerUrl: "http://runner",
    skiaBoardViewport: { x: 1 },
    faceIdRequiredForApproval: true,
  });
  expect(mockWriteAsStringAsync).toHaveBeenCalledWith(
    "file:///documents/bitty-settings.json.pending",
    expect.any(String)
  );
  expect(mockMoveAsync).toHaveBeenCalledWith({
    from: "file:///documents/bitty-settings.json.pending",
    to: "file:///documents/bitty-settings.json",
  });
});

test("reads the complete pending replacement during the native move gap", async () => {
  mockFiles.set(
    "file:///documents/bitty-settings.json.pending",
    JSON.stringify({ runnerUrl: "http://runner", skiaBoardViewport: { x: 1 } })
  );

  expect(await readPersistedSettingsField("skiaBoardViewport")).toEqual({ x: 1 });
});

test("read barrier waits for an in-process settings mutation to finish", async () => {
  let releaseMove = () => {};
  mockMoveBarrier = new Promise<void>((resolve) => { releaseMove = resolve; });
  const mutation = mutatePersistedSettings(() => ({ runnerUrl: "http://new-runner" }));
  await mockWriteStarted;

  let readFinished = false;
  const read = readPersistedSettings().then((settings) => {
    readFinished = true;
    return settings;
  });
  await Promise.resolve();
  expect(readFinished).toBe(false);

  releaseMove();
  await mutation;
  expect(await read).toEqual({ runnerUrl: "http://new-runner" });
});
