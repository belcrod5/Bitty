const mockFiles = new Map<string, string>();
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
  documentDirectory: "file:///documents/",
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  readAsStringAsync: jest.fn(async (path: string) => {
    const value = mockFiles.get(path);
    if (typeof value === "undefined") throw new Error("missing");
    return value;
  }),
  writeAsStringAsync: (...args: [string, string]) => mockWriteAsStringAsync(...args),
  moveAsync: (...args: [{ from: string; to: string }]) => mockMoveAsync(...args),
}));

import {
  mutatePersistedSettings,
  readPersistedSettings,
  readPersistedSettingsField,
} from "./persistedSettingsFile";

beforeEach(() => {
  mockFiles.clear();
  mockMoveBarrier = null;
  mockWriteStarted = new Promise<void>((resolve) => { resolveMockWriteStarted = resolve; });
  jest.clearAllMocks();
});

test("serializes background and React-style updates without losing either field set", async () => {
  await Promise.all([
    mutatePersistedSettings((current) => ({ ...current, runnerUrl: "http://runner" })),
    mutatePersistedSettings((current) => ({
      ...current,
      locationSchedules: [{ id: "office" }],
      locationSchedulePendingStates: [{ eventId: "outside" }],
    })),
  ]);

  expect(await readPersistedSettings()).toEqual({
    runnerUrl: "http://runner",
    locationSchedules: [{ id: "office" }],
    locationSchedulePendingStates: [{ eventId: "outside" }],
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
    JSON.stringify({ runnerUrl: "http://runner", locationSchedules: [{ id: "home" }] })
  );

  expect(await readPersistedSettingsField("locationSchedules")).toEqual([{ id: "home" }]);
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
