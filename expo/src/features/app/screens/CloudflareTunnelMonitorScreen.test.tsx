jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { CloudflareTunnelMonitorScreen } from "./CloudflareTunnelMonitorScreen";

const mockOpenSettingsScreen = jest.fn();
const mockApplyPairing = jest.fn();
const mockRequestPermission = jest.fn();
let mockSupportsCamera = false;
const mockSettings = {
  runnerUrl: "http://127.0.0.1:8788", runnerToken: "test-session", cloudflareAccessClientId: "", cloudflareAccessEnabled: false,
  applyCloudflareRunnerPairing: mockApplyPairing, clearCloudflareAccessCredentials: jest.fn(),
};
jest.mock("../camera", () => ({
  CameraView: (props: any) => require("react").createElement("CameraView", { ...props, testID: "pairing-camera" }),
  get supportsCamera() { return mockSupportsCamera; },
  useCameraPermissions: () => [null, mockRequestPermission],
}));
jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ openSettingsScreen: mockOpenSettingsScreen }) }));
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => mockSettings }));
jest.mock("./RouteDebugPanel", () => ({ RouteDebugPanel: () => {
  const { Text } = require("react-native"); return <Text>接続の詳細ログ</Text>;
} }));
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();
beforeEach(() => {
  jest.clearAllMocks(); mockSupportsCamera = false; mockSettings.runnerUrl = "http://127.0.0.1:8788";
  mockRequestPermission.mockResolvedValue({ granted: true });
  mockApplyPairing.mockResolvedValue({ localRunnerUrl: "https://mac.local:8789" });
  mockFetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, events: [], allowedEvents: [] }) });
  globalThis.fetch = mockFetch;
});
afterEach(() => { globalThis.fetch = originalFetch; jest.useRealTimers(); });

test("the normal monitor still fetches events and returns to Settings", async () => {
  const screen = await render(<CloudflareTunnelMonitorScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  expect(mockFetch.mock.calls[0][0]).toContain("/runner/connection-events");
  expect(screen.getByText("Runner Connection Monitor")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("設定に戻る"));
  expect(mockOpenSettingsScreen).toHaveBeenCalledTimes(1);
});

test("setup-only renders no monitoring or credentials, and starts neither requests nor timers", async () => {
  mockSupportsCamera = true;
  const interval = jest.spyOn(globalThis, "setInterval");
  const screen = await render(<CloudflareTunnelMonitorScreen setupOnly />);
  expect(screen.getByText("接続先を設定")).toBeTruthy();
  expect(screen.getByLabelText("接続QRを読み取る")).toBeTruthy();
  for (const text of ["Runner Connection Monitor", "接続の詳細ログ", "接続設定", "状態", "認証成功", "拒否・エラー", "詳細", "Access資格情報を削除"])
    expect(screen.queryByText(text)).toBeNull();
  expect(mockFetch).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("ログインに戻る"));
  expect(mockOpenSettingsScreen).toHaveBeenCalledTimes(1);
  interval.mockRestore();
});

test("setup scan saves once, shows a clear next action and returns without authenticating", async () => {
  mockSupportsCamera = true;
  let resolve!: (value: unknown) => void;
  mockApplyPairing.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const screen = await render(<CloudflareTunnelMonitorScreen setupOnly />);
  await fireEvent.press(screen.getByLabelText("接続QRを読み取る"));
  const scan = screen.getByTestId("pairing-camera").props.onBarcodeScanned;
  await act(async () => { void scan({ data: "dummy-pairing" }); void scan({ data: "dummy-pairing" }); });
  expect(mockApplyPairing).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ localRunnerUrl: "https://mac.local:8789" }));
  expect(screen.getByText("接続先を保存しました")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("ログインへ"));
  expect(mockOpenSettingsScreen).toHaveBeenCalledTimes(1);
  expect(mockFetch).not.toHaveBeenCalled();
});

test("setup scan errors use short Japanese copy and do not expose decoder details", async () => {
  mockSupportsCamera = true;
  mockApplyPairing.mockRejectedValueOnce(new Error("Unsupported QR type: private-payload"));
  const screen = await render(<CloudflareTunnelMonitorScreen setupOnly />);
  await fireEvent.press(screen.getByLabelText("接続QRを読み取る"));
  await act(async () => screen.getByTestId("pairing-camera").props.onBarcodeScanned({ data: "dummy-pairing" }));
  expect(screen.getByText("保存できませんでした。Macの接続QRでもう一度お試しください。")).toBeTruthy();
  expect(screen.queryByText(/private-payload/)).toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});

test("no-camera guidance claims local login only for an actual loopback connection", async () => {
  const screen = await render(<CloudflareTunnelMonitorScreen setupOnly />);
  expect(screen.getByText(/このMacのサーバー/)).toBeTruthy();
  expect(screen.queryByLabelText("接続QRを読み取る")).toBeNull();
  mockSettings.runnerUrl = "https://runner.example.com";
  await screen.rerender(<CloudflareTunnelMonitorScreen setupOnly />);
  expect(screen.queryByText(/このMacのサーバー/)).toBeNull();
  expect(screen.getByText(/この端末ではQRを読み取れません/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("ログインへ"));
  expect(mockOpenSettingsScreen).toHaveBeenCalledTimes(1);
});

test("switching an existing monitor to setup-only stops its polling", async () => {
  jest.useFakeTimers();
  const screen = await render(<CloudflareTunnelMonitorScreen />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  await screen.rerender(<CloudflareTunnelMonitorScreen setupOnly />);
  await act(async () => jest.advanceTimersByTime(10000));
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test("a queued camera callback after leaving setup cannot apply a pairing", async () => {
  mockSupportsCamera = true;
  const screen = await render(<CloudflareTunnelMonitorScreen setupOnly />);
  await fireEvent.press(screen.getByLabelText("接続QRを読み取る"));
  const scan = screen.getByTestId("pairing-camera").props.onBarcodeScanned;
  await screen.unmount();
  await act(async () => scan({ data: "dummy-pairing" }));
  expect(mockApplyPairing).not.toHaveBeenCalled();
});
