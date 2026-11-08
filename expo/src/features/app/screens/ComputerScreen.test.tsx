import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ComputerScreen } from "./ComputerScreen";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockCopy = jest.fn(async (_path: string) => true);
jest.mock("../clipboard", () => ({ setStringAsync: (path: string) => mockCopy(path) }));
const mockOpenBoard = jest.fn();
const mockOpenDrawer = jest.fn();
jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ openSkiaBoardScreen: mockOpenBoard, openDrawer: mockOpenDrawer }) }));
const mockSettings = { runnerUrl: "https://runner.example", runnerToken: "token" };
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => mockSettings }));

const computer = { hostname: "My Mac", operatingSystem: "macOS", architecture: "arm64", totalMemory: 16 * 1024 ** 3, homePath: "/Users/me" };
const home = { basePath: "/Users/me", parentPath: "/Users", truncated: false, entries: [
  { kind: "dir", name: "Documents", path: "/Users/me/Documents", modifiedAt: "2026-10-30T12:34:00.000Z" },
  { kind: "file", name: " report.txt ", path: "/Users/me/ report.txt ", modifiedAt: null },
] };
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => data });

beforeEach(() => {
  jest.clearAllMocks();
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
  expect(screen.getByText("読み取り専用")).toBeTruthy();
  expect(screen.getByText("—")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(" report.txt のパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me/ report.txt ");
  await fireEvent.press(screen.getByLabelText("Documentsのパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me/Documents");
  await fireEvent.press(screen.getByLabelText("現在のフォルダーのパスをコピー"));
  expect(mockCopy).toHaveBeenLastCalledWith("/Users/me");
  await waitFor(() => expect(screen.getByText("コピーしました: /Users/me")).toBeTruthy());
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
  await waitFor(() => expect(screen.getByText("パスをコピーできませんでした。")).toBeTruthy());
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
