import { Alert } from "react-native";
import {
  isRunnerHtmlFile,
  openRunnerFileContextMenu,
} from "./runnerFileContextMenu";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

type AlertButton = {
  text: string;
  style?: string;
  onPress?: () => void;
};

function openContextMenuButtons(params: {
  filePath: string;
  onOpenHtml?: (target: { path: string; name: string }) => void;
}): AlertButton[] {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  openRunnerFileContextMenu({
    filePathRaw: params.filePath,
    fileNameRaw: "",
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    rootDir: "project",
    getPathLabel: (pathRaw) => String(pathRaw || ""),
    showInfoToast: () => {},
    onOpenMedia: () => {},
    onOpenHtml: params.onOpenHtml,
  });
  expect(alertSpy).toHaveBeenCalledTimes(1);
  const buttons = (alertSpy.mock.calls[0][2] || []) as AlertButton[];
  alertSpy.mockRestore();
  return buttons;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("isRunnerHtmlFile detects html and htm extensions only", () => {
  expect(isRunnerHtmlFile("docs/index.html")).toBe(true);
  expect(isRunnerHtmlFile("docs/INDEX.HTM")).toBe(true);
  expect(isRunnerHtmlFile("docs/readme.md")).toBe(false);
  expect(isRunnerHtmlFile("scripts/run.sh")).toBe(false);
  expect(isRunnerHtmlFile("videos/clip.mp4")).toBe(false);
  expect(isRunnerHtmlFile("Makefile")).toBe(false);
  expect(isRunnerHtmlFile("")).toBe(false);
});

test("shows an open button for html files and passes the target to onOpenHtml", () => {
  const onOpenHtml = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/report.html",
    onOpenHtml,
  });
  const openButton = buttons.find((button) => button.text === "開く");
  expect(openButton).toBeDefined();
  openButton?.onPress?.();
  expect(onOpenHtml).toHaveBeenCalledWith({
    path: "docs/report.html",
    name: "docs/report.html",
  });
});

test("hides the open button when onOpenHtml is not provided", () => {
  const buttons = openContextMenuButtons({ filePath: "docs/report.html" });
  expect(buttons.some((button) => button.text === "開く")).toBe(false);
});

test("hides the open button for non-html files", () => {
  const onOpenHtml = jest.fn();
  const buttons = openContextMenuButtons({
    filePath: "docs/readme.md",
    onOpenHtml,
  });
  expect(buttons.some((button) => button.text === "開く")).toBe(false);
});

test("keeps existing menu items for media and shell script files", () => {
  const onOpenHtml = jest.fn();
  const videoButtons = openContextMenuButtons({
    filePath: "videos/clip.mp4",
    onOpenHtml,
  });
  expect(videoButtons.some((button) => button.text === "再生")).toBe(true);
  expect(videoButtons.some((button) => button.text === "開く")).toBe(false);

  const shellButtons = openContextMenuButtons({
    filePath: "scripts/run.sh",
    onOpenHtml,
  });
  expect(shellButtons.some((button) => button.text === "実行する")).toBe(true);
  expect(shellButtons.some((button) => button.text === "ファイル内容をコピー")).toBe(true);
  expect(shellButtons.some((button) => button.text === "開く")).toBe(false);
});
