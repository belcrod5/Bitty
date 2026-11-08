import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { RunnerLoginScreen } from "./RunnerLoginScreen";
import { readFileSync } from "node:fs";
import { join } from "node:path";
let mockScreen = "skia_board";
let mockToken = "";
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => ({ runnerToken: mockToken, saveRunnerToken: jest.fn() }) }));
jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ activeScreen: mockScreen }) }));
jest.mock("../keyboardController", () => ({ KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock("../components/RunnerLoginSettings", () => ({
  RunnerLoginSettings: () => { const { Text } = require("react-native"); return <Text>本人ログイン</Text>; },
}));
jest.mock("./CloudflareTunnelMonitorScreen", () => ({
  CloudflareTunnelMonitorScreen: () => { const { Text } = require("react-native"); return <Text>接続設定QR</Text>; },
}));

test("unauthenticated navigation cannot reach cached business content, while pairing stays reachable", async () => {
  mockToken = "";
  mockScreen = "skia_board";
  const screen = await render(<RunnerLoginScreen onRetry={jest.fn()} />);
  expect(screen.getByText("本人ログイン")).toBeTruthy();
  mockScreen = "settings"; await screen.rerender(<RunnerLoginScreen onRetry={jest.fn()} />);
  expect(screen.getByText("本人ログイン")).toBeTruthy();
  mockScreen = "cloudflare_tunnel_monitor"; await screen.rerender(<RunnerLoginScreen onRetry={jest.fn()} />);
  expect(screen.getByText("接続設定QR")).toBeTruthy();
});

test("an unverified saved token only shows verification and retry, never a logged-in device list", async () => {
  mockScreen = "skia_board"; mockToken = "bitty_session_v1." + "a".repeat(43);
  const retry = jest.fn();
  const screen = await render(<RunnerLoginScreen onRetry={retry} />);
  expect(screen.getByText("ログイン状態を確認しています")).toBeTruthy();
  expect(screen.queryByText("本人ログイン")).toBeNull();
  await fireEvent.press(screen.getByLabelText("ログイン状態を再確認"));
  expect(retry).toHaveBeenCalledTimes(1);
  mockToken = "";
});

test("the root authentication branch owns the drawer, cached popup and approval overlay together", () => {
  // This is the composition contract at the existing root: the macOS Skia
  // screen deliberately remains mounted during normal navigation, so the gate
  // must enclose that screen and its separate popup/approval siblings as well.
  const root = readFileSync(join(__dirname, "../AppRoot.tsx"), "utf8");
  const start = root.indexOf("{settingsLoaded && (runnerSessionVerified ? <>");
  const end = root.indexOf("</> : <RunnerLoginScreen onRetry=", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const privateChildren = root.slice(start, end);
  for (const component of ["<AppDrawerLayout", "{screenContent}", "<AppOverlays", "<CalendarWriteApprovalModal", "<UserInputModal", "<DrawerSessionPopupHost", "<PopupChatOverlay", "<PushNotificationRegistrar"])
    expect(privateChildren).toContain(component);
});
