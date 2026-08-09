import { Alert } from "react-native";
import { fetchRunnerTextFileContent } from "./runnerFileContent";
import {
  getRunnerFileViewerKind,
  getRunnerFileViewerLocation,
  isRunnerEditableTextFile,
  openRunnerFileContextMenu,
  type RunnerFileViewerTarget,
} from "./runnerFileContextMenu";
import type { WorkspaceFileTarget } from "./workspaceFiles";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("./runnerFileContent", () => ({
  fetchRunnerTextFileContent: jest.fn(),
}));

const fetchRunnerTextFileContentMock = fetchRunnerTextFileContent as jest.Mock;

type AlertButton = {
  text: string;
  style?: string;
  onPress?: () => void;
};

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function openContextMenuButtons(params: {
  filePath: string;
  rootDir?: string;
  onOpenFile?: (target: RunnerFileViewerTarget) => void;
  onSpeakText?: (text: string, target: { path: string; name: string }) => void;
  showInfoToast?: (textRaw: unknown) => void;
  getSkiaBoardAction?: (target: WorkspaceFileTarget) => {
    text: "Skiaボードへ追加" | "Skiaボードから除外";
    onPress: () => void;
  };
}): AlertButton[] {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  openRunnerFileContextMenu({
    filePathRaw: params.filePath,
    fileNameRaw: "",
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDir: params.rootDir || "project",
    getPathLabel: (pathRaw) => String(pathRaw || ""),
    showInfoToast: params.showInfoToast || (() => {}),
    onOpenMedia: () => {},
    onOpenFile: params.onOpenFile,
    onSpeakText: params.onSpeakText,
    getSkiaBoardAction: params.getSkiaBoardAction,
  });
  expect(alertSpy).toHaveBeenCalledTimes(1);
  const buttons = (alertSpy.mock.calls[0][2] || []) as AlertButton[];
  alertSpy.mockRestore();
  return buttons;
}

afterEach(() => {
  jest.restoreAllMocks();
  fetchRunnerTextFileContentMock.mockReset();
});

test("getRunnerFileViewerKind detects supported extensions case-insensitively", () => {
  expect(getRunnerFileViewerKind("docs/index.html")).toBe("html");
  expect(getRunnerFileViewerKind("docs/INDEX.HTM")).toBe("html");
  expect(getRunnerFileViewerKind("diagrams/ARCHITECTURE.DRAWIO")).toBe("drawio");
  expect(getRunnerFileViewerKind("tasks/TODAY.CHECKLIST")).toBe("checklist");
  expect(getRunnerFileViewerKind("docs/readme.md")).toBeNull();
  expect(getRunnerFileViewerKind("Makefile")).toBeNull();
  expect(getRunnerFileViewerKind("")).toBeNull();
});

test("routes checklist files only to the dedicated viewer", () => {
  expect(getRunnerFileViewerKind("tasks/today.checklist")).toBe("checklist");
  expect(isRunnerEditableTextFile("tasks/today.checklist")).toBe(false);
});

test.each([
  ["docs/report.html", "html"],
  ["diagrams/architecture.drawio", "drawio"],
  ["tasks/today.checklist", "checklist"],
] as const)("shows an open button for %s and passes its viewer kind", (filePath, kind) => {
  const onOpenFile = jest.fn();
  const buttons = openContextMenuButtons({ filePath, onOpenFile });
  const openButton = buttons.find((button) => button.text === "開く");
  expect(openButton).toBeDefined();
  openButton?.onPress?.();
  expect(onOpenFile).toHaveBeenCalledWith({
    kind,
    path: filePath,
    name: filePath,
    rootDirectory: "project",
  });
});

test.each([
  ["/work/other/tasks/today.checklist", "checklist"],
  ["/work/other/report.html", "html"],
] as const)("opens root-external absolute %s from its safe file location", (filePath, kind) => {
  const onOpenFile = jest.fn();
  const buttons = openContextMenuButtons({
    filePath,
    rootDir: "/work/current",
    onOpenFile,
  });
  buttons.find((button) => button.text === "開く")?.onPress?.();
  expect(onOpenFile).toHaveBeenCalledWith({
    kind,
    path: filePath,
    name: filePath,
    rootDirectory: filePath.slice(0, filePath.lastIndexOf("/")),
  });
});

test("keeps relative viewer paths with normalized POSIX and Windows roots", () => {
  expect(getRunnerFileViewerLocation("docs/report.html", "/work/current")).toEqual({
    path: "docs/report.html",
    rootDirectory: "/work/current",
  });
  expect(getRunnerFileViewerLocation("report.html", "/")).toEqual({
    path: "report.html",
    rootDirectory: "/",
  });
  expect(getRunnerFileViewerLocation("report.html", "C:/")).toEqual({
    path: "report.html",
    rootDirectory: "C:/",
  });
});

test("keeps absolute paths owned by POSIX or Windows drive roots", () => {
  expect(getRunnerFileViewerLocation("/report.html", "/")).toEqual({
    path: "/report.html",
    rootDirectory: "/",
  });
  expect(getRunnerFileViewerLocation("/work/current/report.html", "/work/current")).toEqual({
    path: "/work/current/report.html",
    rootDirectory: "/work/current",
  });
  expect(getRunnerFileViewerLocation("C:/report.html", "C:/")).toEqual({
    path: "C:/report.html",
    rootDirectory: "C:/",
  });
});

test("uses the correct POSIX or drive root for external root-level files", () => {
  expect(getRunnerFileViewerLocation("/report.html", "/work/current")).toEqual({
    path: "/report.html",
    rootDirectory: "/",
  });
  expect(getRunnerFileViewerLocation("D:/report.html", "C:/work/current")).toEqual({
    path: "D:/report.html",
    rootDirectory: "D:/",
  });
});

test("hides the open button when onOpenFile is not provided", () => {
  const buttons = openContextMenuButtons({ filePath: "docs/report.html" });
  expect(buttons.some((button) => button.text === "開く")).toBe(false);
});

test("hides the open button for unsupported files", () => {
  const onOpenFile = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/readme.md",
    onOpenFile,
  });
  expect(buttons.some((button) => button.text === "開く")).toBe(false);
});

test("shows a speak button for text files and passes fetched content to onSpeakText", async () => {
  fetchRunnerTextFileContentMock.mockResolvedValue({
    path: "docs/readme.md",
    content: "読み上げ対象のテキスト",
    totalBytes: 10,
    version: "v1",
  });
  const onSpeakText = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/readme.md",
    onSpeakText,
  });
  const speakButton = buttons.find((button) => button.text === "読み上げ");
  expect(speakButton).toBeDefined();
  speakButton?.onPress?.();
  await flushPromises();
  expect(fetchRunnerTextFileContentMock).toHaveBeenCalledWith(expect.objectContaining({
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDir: "project",
    path: "docs/readme.md",
  }));
  expect(onSpeakText).toHaveBeenCalledWith("読み上げ対象のテキスト", {
    path: "docs/readme.md",
    name: "docs/readme.md",
  });
});

test("hides the speak button when onSpeakText is not provided", () => {
  const buttons = openContextMenuButtons({ filePath: "docs/readme.md" });
  expect(buttons.some((button) => button.text === "読み上げ")).toBe(false);
});

test("hides the speak button for non-text files", () => {
  const onSpeakText = jest.fn();
  const htmlButtons = openContextMenuButtons({
    filePath: "docs/report.html",
    onSpeakText,
  });
  expect(htmlButtons.some((button) => button.text === "読み上げ")).toBe(false);

  const shellButtons = openContextMenuButtons({
    filePath: "scripts/run.sh",
    onSpeakText,
  });
  expect(shellButtons.some((button) => button.text === "読み上げ")).toBe(false);

  const videoButtons = openContextMenuButtons({
    filePath: "videos/clip.mp4",
    onSpeakText,
  });
  expect(videoButtons.some((button) => button.text === "読み上げ")).toBe(false);
});

test("shows a toast instead of speaking when the file content is empty", async () => {
  fetchRunnerTextFileContentMock.mockResolvedValue({
    path: "docs/empty.txt",
    content: "   \n",
    totalBytes: 4,
    version: "v1",
  });
  const onSpeakText = jest.fn();
  const showInfoToast = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/empty.txt",
    onSpeakText,
    showInfoToast,
  });
  const speakButton = buttons.find((button) => button.text === "読み上げ");
  speakButton?.onPress?.();
  await flushPromises();
  expect(onSpeakText).not.toHaveBeenCalled();
  expect(showInfoToast).toHaveBeenCalledWith("読み上げるテキストがありません: docs/empty.txt");
});

test("shows an alert when fetching the file content for speech fails", async () => {
  fetchRunnerTextFileContentMock.mockRejectedValue(new Error("HTTP 500"));
  const onSpeakText = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/readme.md",
    onSpeakText,
  });
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const speakButton = buttons.find((button) => button.text === "読み上げ");
  speakButton?.onPress?.();
  await flushPromises();
  expect(onSpeakText).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledWith("読み上げ失敗", "HTTP 500");
});

test("keeps existing menu items for media and shell script files", () => {
  const onOpenFile = jest.fn();
  const videoButtons = openContextMenuButtons({
    filePath: "videos/clip.mp4",
    onOpenFile,
  });
  expect(videoButtons.some((button) => button.text === "再生")).toBe(true);
  expect(videoButtons.some((button) => button.text === "開く")).toBe(false);

  const shellButtons = openContextMenuButtons({
    filePath: "scripts/run.sh",
    onOpenFile,
  });
  expect(shellButtons.some((button) => button.text === "実行する")).toBe(true);
  expect(shellButtons.some((button) => button.text === "ファイル内容をコピー")).toBe(true);
  expect(shellButtons.some((button) => button.text === "開く")).toBe(false);
});

test("appends the caller's Skia board action to the existing file menu", () => {
  const onPress = jest.fn();
  const getSkiaBoardAction = jest.fn(() => ({
    text: "Skiaボードへ追加" as const,
    onPress,
  }));
  const buttons = openContextMenuButtons({
    filePath: "docs/readme.md",
    getSkiaBoardAction,
  });

  expect(getSkiaBoardAction).toHaveBeenCalledWith({
    path: "docs/readme.md",
    name: "docs/readme.md",
    rootDirectory: "project",
  });
  buttons.find((button) => button.text === "Skiaボードへ追加")?.onPress?.();
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("passes the same external absolute location to open and Skia board actions", () => {
  const onOpenFile = jest.fn();
  const getSkiaBoardAction = jest.fn(() => ({
    text: "Skiaボードへ追加" as const,
    onPress: jest.fn(),
  }));
  const buttons = openContextMenuButtons({
    filePath: "/external/tasks/today.checklist",
    rootDir: "/workspace",
    onOpenFile,
    getSkiaBoardAction,
  });

  buttons.find((button) => button.text === "開く")?.onPress?.();
  expect(onOpenFile).toHaveBeenCalledWith({
    kind: "checklist",
    path: "/external/tasks/today.checklist",
    name: "/external/tasks/today.checklist",
    rootDirectory: "/external/tasks",
  });
  expect(getSkiaBoardAction).toHaveBeenCalledWith({
    path: "/external/tasks/today.checklist",
    name: "/external/tasks/today.checklist",
    rootDirectory: "/external/tasks",
  });
});
