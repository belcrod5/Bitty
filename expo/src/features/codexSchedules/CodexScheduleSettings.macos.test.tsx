import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolve, type ResolutionContext } from "metro-resolver";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Platform, Text } from "react-native";

import { AppModal, AppModalHost } from "../app/components/AppModal.macos";
import type { CodexSchedule } from "./codexScheduleTypes";

jest.mock("../app/components/AppModal", () => jest.requireActual("../app/components/AppModal.macos"));
jest.mock("../app/keyboardController", () => jest.requireActual("../app/keyboardController.macos"));
jest.mock("../app/components/DateTimePicker", () => jest.requireActual("../app/components/DateTimePicker.macos"));
jest.mock("react-native/Libraries/Modal/Modal", () => {
  throw new Error("macOS scheduling must use AppModal");
});
jest.mock("@react-native-community/datetimepicker", () => {
  throw new Error("The iOS date picker must not load on macOS");
});
jest.mock("react-native-keyboard-controller", () => {
  throw new Error("The iOS keyboard controller must not load on macOS");
});
jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
jest.mock("./CodexSchedulesContext", () => ({
  useCodexSchedules: () => ({ refresh: mockRefresh, save: mockSave }),
}));
jest.mock("../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => ({
    connect: async () => {},
    request: async () => ({ op: "voice.orchestrators.list.result", payload: { orchestrators: [] } }),
  }),
}));

function resolveMacImport(originModulePath: string, moduleName: string) {
  return resolve({
    allowHaste: false,
    customResolverOptions: Object.create(null),
    disableHierarchicalLookup: false,
    doesFileExist: existsSync,
    extraNodeModules: null,
    dev: false,
    getPackage: () => null,
    mainFields: ["react-native", "browser", "main"],
    nodeModulesPaths: [],
    resolveAsset: () => null,
    redirectModulePath: (filePath) => filePath,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    unstable_conditionNames: [],
    unstable_conditionsByPlatform: {},
    unstable_enablePackageExports: false,
    unstable_logWarning: (message) => { throw new Error(message); },
    originModulePath,
    assetExts: new Set(),
    sourceExts: ["js", "jsx", "ts", "tsx"],
    preferNativePlatform: true,
    getPackageForModule: () => null,
    fileSystemLookup: (filePath: string) => {
      try {
        const stat = statSync(filePath);
        return { exists: true, type: stat.isDirectory() ? "d" : "f", realPath: realpathSync(filePath) };
      } catch {
        return { exists: false };
      }
    },
  } satisfies ResolutionContext, moduleName, "macos");
}

const settingsPath = path.join(__dirname, "CodexScheduleSettings.tsx");
const mockRefresh = jest.fn();
const mockSave = jest.fn();
const schedule: CodexSchedule = {
  id: "11111111-1111-4111-8111-111111111111", name: "Morning", enabled: true,
  startLocal: "2027-02-03T09:07:00", timeZone: "Asia/Tokyo", rrule: "FREQ=DAILY",
  action: { kind: "llm", cwd: "/work", modelRef: "openai-codex/gpt-5.6", reasoningEffort: "high", prompt: "Check", threadId: "current" },
  nextOccurrenceAt: null, lastDispatch: null,
};
const props = {
  runnerUrl: "http://runner", runnerToken: "token", currentCwd: "/work",
  currentModelRef: "openai-codex/gpt-5.6", currentReasoningEffort: "high" as const,
  currentThreadId: "current", directories: [{ path: "/work", displayName: "Work" }],
  modelOptions: [{ value: "openai-codex/gpt-5.6", label: "GPT-5.6" }], thinkOptions: ["high"] as const,
};

const originalOS = Platform.OS;
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation((message) => {
    if (!String(message).includes("SafeAreaView has been deprecated")) throw new Error(String(message));
  });
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  mockRefresh.mockResolvedValue({ revision: 4, schedules: [schedule] });
  mockSave.mockImplementation(async (_revision: number, schedules: CodexSchedule[]) => ({ revision: 5, schedules }));
});
afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  jest.clearAllMocks();
  warnSpy.mockRestore();
});

test("Metro resolves the shared schedule feature and only its native date widget differs on macOS", () => {
  const fromTitleMenu = resolveMacImport(path.join(__dirname, "../app/screens/ChatScreen.tsx"), "../../codexSchedules/CodexScheduleSettings");
  expect(fromTitleMenu).toEqual({ type: "sourceFile", filePath: settingsPath });
  expect(resolveMacImport(path.join(__dirname, "CodexScheduleEditor.tsx"), "../app/components/DateTimePicker"))
    .toEqual({ type: "sourceFile", filePath: path.join(__dirname, "../app/components/DateTimePicker.macos.tsx") });
});

test("macOS opens shared scheduling, edits native dates and nested options, then saves the same definition", async () => {
  const resolved = resolveMacImport(path.join(__dirname, "../app/screens/ChatScreen.tsx"), "../../codexSchedules/CodexScheduleSettings");
  if (resolved.type !== "sourceFile") throw new Error("Schedule settings must resolve to source");
  const { CodexScheduleSettings } = require(resolved.filePath) as typeof import("./CodexScheduleSettings");
  const closeTitleMenu = jest.fn();
  const screen = await render(<AppModalHost>
    <Text testID="app-content">App</Text>
    <AppModal visible onRequestClose={closeTitleMenu}>
      <Text>タイトルメニュー</Text><CodexScheduleSettings {...props} />
    </AppModal>
  </AppModalHost>);
  await fireEvent.press(screen.getByLabelText("スケジュール実行"));
  await fireEvent.press(await screen.findByLabelText("Morningを編集"));
  expect(screen.getByLabelText("開始日").type).toBe("BittyDateTimePicker");
  expect(screen.getByLabelText("開始時刻")).toHaveProp("mode", "time");
  expect(screen.getByLabelText("開始日")).toHaveProp("timestamp", new Date(2027, 1, 3, 9, 7).getTime());
  await fireEvent(screen.getByLabelText("開始日"), "change", { nativeEvent: { timestamp: new Date(2028, 1, 29, 12).getTime() } });
  await fireEvent(screen.getByLabelText("開始時刻"), "change", { nativeEvent: { timestamp: new Date(2028, 1, 29, 16, 42).getTime() } });
  await fireEvent.press(screen.getByLabelText("繰り返し"));
  await fireEvent(screen.getByTestId("app-content"), "keyDownCapture", { nativeEvent: { key: "Escape" }, stopPropagation: jest.fn() });
  await waitFor(() => expect(screen.queryByText("毎週")).toBeNull());
  expect(screen.getByLabelText("開始日")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("スケジュール名"), "Updated");
  await fireEvent.press(screen.getByLabelText("編集を閉じる"));
  await waitFor(() => expect(screen.queryByLabelText("開始日")).toBeNull());
  await act(async () => fireEvent.press(screen.getByLabelText("スケジュールを保存")));
  expect(mockSave).toHaveBeenCalledWith(4, [{ ...schedule, name: "Updated", startLocal: "2028-02-29T16:42:00" }]);
  expect(closeTitleMenu).not.toHaveBeenCalled();
  await screen.unmount();
});
