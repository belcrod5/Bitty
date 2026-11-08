import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ComputerScreen } from "./ComputerScreen";

let mockViewerProps: any;
let mockEditorProps: any;
let mockMediaProps: any;
jest.mock("../components/RunnerMediaViewer", () => ({ RunnerMediaViewer: (props: any) => {
  const { View, Text, TouchableOpacity } = require("react-native");
  mockMediaProps = props;
  return <View><Text>Existing media: {props.media.kind}</Text><TouchableOpacity accessibilityLabel="閉じる" onPress={props.onRequestClose}><Text>閉じる</Text></TouchableOpacity></View>;
} }));
jest.mock("../components/RunnerFileViewer", () => ({ RunnerFileViewer: (props: any) => {
  const { Text } = require("react-native");
  mockViewerProps = props;
  return <Text>Existing viewer: {props.target.kind}</Text>;
} }));
jest.mock("../components/WorkspaceTextFileEditor", () => ({ WorkspaceTextFileEditor: (props: any) => {
  const { Text } = require("react-native");
  mockEditorProps = props;
  return <Text>Existing editor: {props.target.name}</Text>;
} }));
jest.mock("../utils/workspaceFiles", () => ({ writeWorkspaceTextFile: (...args: unknown[]) => mockWriteFile(...args) }));
const mockWriteFile = jest.fn(async (..._args: unknown[]) => ({ ok: true, path: "/Users/me/note.md", version: "v2" }));

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockToast = jest.fn();
jest.mock("../contexts/ConversationContext", () => ({ useConversation: () => ({ showChatBottomToast: mockToast }) }));
const mockCopy = jest.fn(async (_path: string) => true);
jest.mock("../clipboard", () => ({ setStringAsync: (path: string) => mockCopy(path) }));
const mockOpenBoard = jest.fn();
const mockOpenDrawer = jest.fn();
jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ openSkiaBoardScreen: mockOpenBoard, openDrawer: mockOpenDrawer }) }));
const mockSettings = { runnerUrl: "https://runner.example", runnerToken: "token" };
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => mockSettings }));

const computer = { hostname: "My Mac", operatingSystem: "macOS", architecture: "arm64", totalMemory: 16 * 1024 ** 3, homePath: "/Users/me" };
const home = { basePath: "/Users/me", rootPath: "/", parentPath: "/Users", truncated: false, entries: [
  { kind: "dir", name: "Documents", path: "/Users/me/Documents", modifiedAt: "2026-10-30T12:34:00.000Z" },
  { kind: "file", name: " report.txt ", path: "/Users/me/ report.txt ", modifiedAt: null },
] };
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => data });

beforeEach(() => {
  jest.clearAllMocks();
  mockViewerProps = null; mockEditorProps = null; mockMediaProps = null;
  mockSettings.runnerUrl = "https://runner.example";
  mockSettings.runnerToken = "token";
  mockCopy.mockResolvedValue(true);
  mockFetch.mockImplementation(async (url: string) => response(url.endsWith("/computer") ? computer : home));
  global.fetch = mockFetch;
});
afterAll(() => { global.fetch = originalFetch; });

test("shows Finder columns and computer info, copies exact file/folder paths, and offers no writes", async () => {
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("Documents")).toBeTruthy());
  expect(screen.getByText("名前")).toBeTruthy();
  expect(screen.getByText("更新日")).toBeTruthy();
  expect(screen.queryByText("読み取り専用")).toBeNull();
  expect(screen.getByText("—")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(" report.txt のパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me/ report.txt ");
  await fireEvent.press(screen.getByLabelText("Documentsのパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me/Documents");
  await fireEvent.press(screen.getByLabelText("現在のフォルダーのパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me");
  expect(mockToast).toHaveBeenLastCalledWith("assistant", "コピーしました: /Users/me");
  await fireEvent.press(screen.getByLabelText("コンピューター情報を表示"));
  expect(screen.getByText("macOS · arm64")).toBeTruthy();
  expect(screen.getByText("メモリ 16 GB")).toBeTruthy();
  expect(screen.queryByText("削除")).toBeNull();
  expect(screen.queryByText("実行する")).toBeNull();
  expect(mockFetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  expect(mockFetch.mock.calls[1][1].headers.authorization).toBe("Bearer token");
});

test("opens folders, returns to parent/home and returns to the menu", async () => {
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("Documents")).toBeTruthy());
  mockFetch.mockResolvedValueOnce(response({ basePath: "/Users/me/Documents", parentPath: "/Users/me", entries: [], truncated: false }));
  await fireEvent.press(screen.getByLabelText("Documentsフォルダーを開く"));
  await waitFor(() => expect(screen.getByText("フォルダーは空です")).toBeTruthy());
  expect(new URL(mockFetch.mock.calls[2][0]).searchParams.get("path")).toBe("/Users/me/Documents");
  await fireEvent.press(screen.getByLabelText("上のフォルダーへ"));
  await waitFor(() => expect(screen.getByText("Documents")).toBeTruthy());
  expect(new URL(mockFetch.mock.calls[3][0]).searchParams.get("path")).toBe("/Users/me");
  await fireEvent.press(screen.getByLabelText("ホームフォルダーを開く"));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(5));
  await fireEvent.press(screen.getByLabelText("メニューに戻る"));
  expect(mockOpenBoard).toHaveBeenCalledTimes(1);
  expect(mockOpenDrawer).toHaveBeenCalledTimes(1);
});

test("shows listing errors with retry and reports truncation and clipboard failures", async () => {
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ message: "読み取り権限がありません" }, false));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("読み取り権限がありません")).toBeTruthy());
  mockFetch.mockResolvedValueOnce(response({ ...home, truncated: true }));
  await fireEvent.press(screen.getByLabelText("ファイル一覧を更新"));
  await waitFor(() => expect(screen.getByText("件数が多いため、一部の項目を表示しています。")).toBeTruthy());
  mockCopy.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await fireEvent.press(screen.getByLabelText("Documentsのパスをコピー"));
  expect(mockToast).toHaveBeenCalledWith("assistant", "パスをコピーできませんでした。");
});

test("a runner switch immediately removes old files and ignores a late response", async () => {
  let finishOld: (value: unknown) => void = () => {};
  mockFetch.mockResolvedValueOnce(response(computer))
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  mockSettings.runnerUrl = "https://other.example";
  mockSettings.runnerToken = "other-token";
  mockFetch.mockResolvedValueOnce(response({ ...computer, hostname: "Other Mac", homePath: "/Users/other" }))
    .mockResolvedValueOnce(response({ basePath: "/Users/other", parentPath: "/Users", entries: [], truncated: false }));
  await screen.rerender(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("Other Mac")).toBeTruthy());
  await act(async () => { finishOld(response(home)); });
  expect(screen.queryByText("Documents")).toBeNull();
  expect(screen.getByText("/Users/other")).toBeTruthy();
  expect(mockFetch.mock.calls[3][1].headers.authorization).toBe("Bearer other-token");
});

test.each([
  ["photo.png", "media", "image"], ["movie.mp4", "media", "video"], ["sound.mp3", "media", "audio"],
  ["page.html", "viewer", "html"], ["diagram.drawio", "viewer", "drawio"], ["tasks.checklist", "viewer", "checklist"],
  ["note.md", "text", "note.md"], ["note.txt", "text", "note.txt"],
])("opens %s through the existing %s component while its copy button remains separate", async (name, type, kind) => {
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ ...home, entries: [
    { kind: "file", name, path: `/Users/me/${name}`, modifiedAt: null },
  ] }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  await fireEvent.press(screen.getByLabelText(`${name}のパスをコピー`));
  expect(mockCopy).toHaveBeenCalledWith(`/Users/me/${name}`);
  expect(mockMediaProps).toBeNull(); expect(mockViewerProps).toBeNull(); expect(mockEditorProps).toBeNull();
  await fireEvent.press(screen.getByLabelText(`${name}を開く`));
  expect(screen.getByText(`Existing ${type === "text" ? "editor" : type}: ${kind}`)).toBeTruthy();
  if (type === "media") expect(mockMediaProps.media.renameFile).toBeUndefined();
  if (type === "text") { expect(mockEditorProps.target.renameFile).toBeUndefined(); expect(mockEditorProps.target.deleteFile).toBeUndefined(); }
});

test("saves through the opened target root and captured credentials, and hides viewers on runner change", async () => {
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ ...home, entries: [
    { kind: "file", name: "note.md", path: "/Users/me/note.md", modifiedAt: null },
  ] }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("note.md")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("note.mdを開く"));
  const editor = mockEditorProps;
  await act(async () => { await editor.onSave(editor.target, "updated", "v1"); });
  expect(mockWriteFile).toHaveBeenCalledWith({ runnerUrl: "https://runner.example", runnerToken: "token", rootDirectory: "/", path: "/Users/me/note.md", content: "updated", expectedVersion: "v1" });
  mockSettings.runnerUrl = "https://other.example";
  mockSettings.runnerToken = "other-token";
  await screen.rerender(<ComputerScreen />);
  expect(screen.queryByText("Existing editor: note.md")).toBeNull();
  await expect(editor.onSave(editor.target, "stale", "v2")).rejects.toThrow("接続先が変更");
  expect(mockWriteFile).toHaveBeenCalledTimes(1);
});

test("unsupported file rows only copy their exact paths", async () => {
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ ...home, entries: [
    { kind: "file", name: "archive.bin", path: "/Users/me/archive.bin", modifiedAt: null },
  ] }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("archive.bin")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("ファイルのパスをコピー: archive.bin"));
  expect(mockCopy).toHaveBeenCalledWith("/Users/me/archive.bin");
  expect(mockMediaProps).toBeNull(); expect(mockViewerProps).toBeNull(); expect(mockEditorProps).toBeNull();
});

test("copies a symbolic link alias but opens and saves its resolved target", async () => {
  const alias = "/Users/me/Shortcut.md";
  const resolvedPath = String.raw`/Volumes/project /memo\copy.md `;
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ ...home, entries: [
    { kind: "file", name: "Shortcut.md", path: alias, resolvedPath, modifiedAt: null },
  ] }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("Shortcut.md")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("Shortcut.mdのパスをコピー"));
  expect(mockCopy).toHaveBeenCalledWith(alias);
  await fireEvent.press(screen.getByLabelText("Shortcut.mdを開く"));
  expect(mockEditorProps.target.path).toBe(resolvedPath);
  expect(mockEditorProps.target.rootDirectory).toBe("/");
  await act(async () => { await mockEditorProps.onSave(mockEditorProps.target, "selected target", "v1"); });
  expect(mockWriteFile).toHaveBeenCalledWith(expect.objectContaining({ rootDirectory: "/", path: resolvedPath, content: "selected target" }));
});

test("opens the selected spaced Markdown filename without changing its identity", async () => {
  mockFetch.mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response({ ...home, entries: [
    { kind: "file", name: "memo.md", path: "/Users/me/memo.md", modifiedAt: null },
    { kind: "file", name: "memo.md ", path: "/Users/me/memo.md ", modifiedAt: null },
  ] }));
  const screen = await render(<ComputerScreen />);
  await waitFor(() => expect(screen.getByText("memo.md ", { normalizer: (text) => text })).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("memo.md を開く"));
  expect(mockEditorProps.target).toMatchObject({ name: "memo.md ", path: "/Users/me/memo.md ", rootDirectory: "/" });
});
