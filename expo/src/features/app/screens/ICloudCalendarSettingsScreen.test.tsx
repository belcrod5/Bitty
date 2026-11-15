import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ICloudCalendarSettingsScreen } from "./ICloudCalendarSettingsScreen";
import { requestICloudCalendar } from "../../calendar/icloudCalendarClient";

jest.mock("../../calendar/icloudCalendarClient", () => ({ requestICloudCalendar: jest.fn() }));
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => ({ runnerUrl: "https://runner.example.com", runnerToken: "runner-token" }) }));
jest.mock("../styles", () => ({ useAppStyles: () => ({}) }));
jest.mock("../keyboardController", () => ({ KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const request = requestICloudCalendar as jest.MockedFunction<typeof requestICloudCalendar>;
const disconnected = { configured: false, enabled: false, account: "", testedAt: null };
const connected = { configured: true, enabled: true, account: "test@example.invalid", testedAt: "2026-11-15T00:00:00.000Z" };
const tested = { verificationToken: "verified-token", expiresAt: "2099-01-01T00:00:00.000Z", calendarCount: 1, eventCount: 2, truncated: false };

beforeEach(() => { request.mockReset(); request.mockResolvedValue(disconnected); });

async function enter() {
  const screen = await render(<ICloudCalendarSettingsScreen onBack={jest.fn()} />);
  await waitFor(() => expect(request).toHaveBeenCalledWith("https://runner.example.com", "runner-token", "status"));
  await fireEvent.changeText(screen.getByLabelText("Apple Account（メールアドレス）"), "test@example.invalid");
  await fireEvent.changeText(screen.getByLabelText("アプリ用パスワード"), "abcd-efgh-ijkl-mnop");
  return screen;
}

test("explains app-specific password generation and defaults to visible input with hide toggle", async () => {
  const screen = await enter();
  expect(screen.getByText(/通常のApple Accountパスワードではなく/)).toBeTruthy();
  expect(screen.getByText(/開発者アカウントは不要/)).toBeTruthy();
  expect(screen.getByLabelText("アプリ用パスワード").props.secureTextEntry).toBe(false);
  await fireEvent.press(screen.getByLabelText("パスワードを隠す"));
  expect(screen.getByLabelText("アプリ用パスワード").props.secureTextEntry).toBe(true);
});

test("saving requires a successful test, sends only its token, and clears input password", async () => {
  const screen = await enter();
  expect(screen.getByLabelText("保存して有効にする").props.accessibilityState.disabled).toBe(true);
  request.mockResolvedValueOnce(tested);
  await fireEvent.press(screen.getByLabelText("接続をテスト"));
  await waitFor(() => expect(screen.getByText(/接続テスト成功/)).toBeTruthy());
  expect(request.mock.calls.at(-1)?.[3]).toEqual({ method: "POST", body: JSON.stringify({ account: "test@example.invalid", password: "abcd-efgh-ijkl-mnop" }) });
  request.mockResolvedValueOnce(connected);
  await fireEvent.press(screen.getByLabelText("保存して有効にする"));
  await waitFor(() => expect(screen.getByText("iCloudカレンダーを有効にしました。")).toBeTruthy());
  expect(request.mock.calls.at(-1)?.[3]).toEqual({ method: "PUT", body: JSON.stringify({ verificationToken: tested.verificationToken }) });
  expect(screen.getByLabelText("アプリ用パスワード").props.value).toBe("");
});

test("editing either credential invalidates a successful connection test", async () => {
  const screen = await enter();
  request.mockResolvedValueOnce(tested);
  await fireEvent.press(screen.getByLabelText("接続をテスト"));
  await waitFor(() => expect(screen.getByText(/接続テスト成功/)).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText("Apple Account（メールアドレス）"), "other@example.invalid");
  expect(screen.getByLabelText("保存して有効にする").props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByText(/接続テスト成功/)).toBeNull();
});

test("a failed test leaves save disabled and shows the error", async () => {
  const screen = await enter();
  request.mockRejectedValueOnce(new Error("HTTP 401: 認証に失敗しました。"));
  await fireEvent.press(screen.getByLabelText("接続をテスト"));
  await waitFor(() => expect(screen.getByRole("alert").props.children).toContain("HTTP 401"));
  expect(screen.getByLabelText("保存して有効にする").props.accessibilityState.disabled).toBe(true);
});

test("typing during initial status loading keeps edits and still reveals the existing connection", async () => {
  let resolve!: (value: typeof connected) => void;
  request.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const screen = await render(<ICloudCalendarSettingsScreen onBack={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText("Apple Account（メールアドレス）"), "edited@example.invalid");
  resolve(connected);
  await waitFor(() => expect(screen.getByText("接続済み・有効")).toBeTruthy());
  expect(screen.getByLabelText("Apple Account（メールアドレス）").props.value).toBe("edited@example.invalid");
  expect(screen.getByLabelText("iCloudの接続を解除")).toBeTruthy();
});
