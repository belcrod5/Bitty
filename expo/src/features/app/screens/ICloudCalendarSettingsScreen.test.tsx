import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ICloudCalendarSettingsScreen } from "./ICloudCalendarSettingsScreen";
import { requestICloudCalendar } from "../../calendar/icloudCalendarClient";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
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
  expect(screen.getByText(/通常のパスワードでは接続できません/)).toBeTruthy();
  expect(screen.queryByText(/開発者アカウントは不要/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("アプリ用パスワードの発行方法"));
  expect(screen.getByLabelText("アプリ用パスワードの発行方法").props.accessibilityState.expanded).toBe(true);
  expect(screen.getByText(/開発者アカウントは不要/)).toBeTruthy();
  expect(screen.getByLabelText("アプリ用パスワード").props.secureTextEntry).toBe(false);
  await fireEvent.press(screen.getByLabelText("パスワードを隠す"));
  expect(screen.getByLabelText("アプリ用パスワード").props.secureTextEntry).toBe(true);
});

test("saving requires a successful test, sends only its token, and clears input password", async () => {
  const screen = await enter();
  expect(screen.queryByLabelText("保存して有効にする")).toBeNull();
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
  expect(screen.queryByLabelText("保存して有効にする")).toBeNull();
  expect(screen.queryByText(/接続テスト成功/)).toBeNull();
});

test("a failed test keeps save unavailable and shows the error", async () => {
  const screen = await enter();
  request.mockRejectedValueOnce(new Error("HTTP 401: 認証に失敗しました。"));
  await fireEvent.press(screen.getByLabelText("接続をテスト"));
  await waitFor(() => expect(screen.getByRole("alert").props.children).toContain("HTTP 401"));
  expect(screen.queryByLabelText("保存して有効にする")).toBeNull();
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

test("connected controls use a switch and a separate disconnect action without exposing credentials", async () => {
  request.mockResolvedValueOnce(connected);
  const onBack = jest.fn();
  const screen = await render(<ICloudCalendarSettingsScreen onBack={onBack} />);
  await waitFor(() => expect(screen.getByText("接続済み・有効")).toBeTruthy());
  expect(screen.getByLabelText("アプリ用パスワード").props.value).toBe("");
  expect(screen.getByLabelText("iCloudカレンダーを使用").props.value).toBe(true);
  request.mockResolvedValueOnce({ ...connected, enabled: false });
  await fireEvent(screen.getByLabelText("iCloudカレンダーを使用"), "valueChange", false);
  await waitFor(() => expect(screen.getByLabelText("iCloudカレンダーを使用").props.value).toBe(false));
  expect(request.mock.calls.at(-1)?.[3]).toEqual({ method: "PATCH", body: JSON.stringify({ enabled: false }) });
  request.mockResolvedValueOnce(disconnected);
  await fireEvent.press(screen.getByLabelText("iCloudの接続を解除"));
  await waitFor(() => expect(screen.getByText("未接続")).toBeTruthy());
  expect(request.mock.calls.at(-1)?.[3]).toEqual({ method: "DELETE" });
  expect(screen.queryByLabelText("iCloudカレンダーを使用")).toBeNull();
  await fireEvent.press(screen.getByLabelText("設定に戻る"));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("busy connection work disables the switch and disconnect action", async () => {
  request.mockResolvedValueOnce(connected);
  const screen = await render(<ICloudCalendarSettingsScreen onBack={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("接続済み・有効")).toBeTruthy());
  let resolve!: (value: typeof connected) => void;
  request.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await fireEvent(screen.getByLabelText("iCloudカレンダーを使用"), "valueChange", false);
  expect(screen.getByLabelText("iCloudカレンダーを使用").props.disabled).toBe(true);
  expect(screen.getByLabelText("iCloudの接続を解除").props.accessibilityState.disabled).toBe(true);
  resolve({ ...connected, enabled: false });
  await waitFor(() => expect(screen.getByLabelText("iCloudカレンダーを使用").props.disabled).toBe(false));
});
