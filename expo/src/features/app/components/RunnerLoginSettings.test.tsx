jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { RunnerLoginSettings } from "./RunnerLoginSettings";
import { requestRunnerLogin, RunnerLoginError } from "../utils/runnerLogin";
import { Alert } from "react-native";

const mockSave = jest.fn();
const mockOpenQr = jest.fn();
const mockCopy = jest.fn(async (_text: string) => {});
jest.mock("../clipboard", () => ({ setStringAsync: (text: string) => mockCopy(text) }));
const SESSION = "bitty_session_v1." + "a".repeat(43);
const mockSettings = { runnerUrl: "https://runner.test", runnerToken: "", saveRunnerToken: mockSave };
jest.mock("expo-crypto", () => ({ randomUUID: () => "test-random-uuid-12345678901234567890" }));
jest.mock("../contexts/AppSettingsContext", () => ({ useAppSettings: () => mockSettings }));
jest.mock("../contexts/AppShellContext", () => ({ useAppShell: () => ({ openCloudflareTunnelMonitorScreen: mockOpenQr }) }));
jest.mock("../utils/runnerLogin", () => ({ ...jest.requireActual("../utils/runnerLogin"), requestRunnerLogin: jest.fn() }));
const requestMock = jest.mocked(requestRunnerLogin);
beforeEach(() => {
  jest.clearAllMocks(); mockSettings.runnerToken = ""; mockSettings.runnerUrl = "https://runner.test";
  mockSave.mockResolvedValue(undefined);
  requestMock.mockResolvedValue({ challengeId: "challenge-1", expiresAt: new Date(Date.now() + 600000).toISOString() });
});
afterEach(() => jest.useRealTimers());

async function mailForm(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.changeText(screen.getByLabelText("メールアドレス"), "owner@example.test");
  await fireEvent.press(screen.getByLabelText("確認メールを送る"));
  await fireEvent.changeText(screen.getByLabelText("メール確認コード"), "12345678");
}
async function codeForm(screen: Awaited<ReturnType<typeof render>>) {
  await mailForm(screen);
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("認証アプリのコード"), "123456");
}
function signedIn() {
  mockSettings.runnerToken = SESSION;
  requestMock.mockImplementation(async (_origin, path) => {
    if (path === "/auth/session") return { sessionId: "self", ownerEmail: "owner@example.test", expiresAt: "2026-12-01T00:00:00Z" };
    if (path === "/auth/devices") return { devices: [{ id: "other", name: "別のMac", os: "macos", current: false, lastUsedAt: "2026-11-08T12:00:00Z" }] };
    return {};
  });
}
function acceptAlert() {
  const args = jest.mocked(Alert.alert).mock.calls.at(-1)!;
  const buttons = args[2];
  return buttons?.find((button) => button.style === "destructive")?.onPress?.();
}

test("guides email, eight digits and six digits before sending both factors together", async () => {
  const screen = await render(<RunnerLoginSettings />);
  expect(screen.getByText("Bittyにログイン")).toBeTruthy();
  expect(screen.queryByLabelText("メール確認コード")).toBeNull();
  await fireEvent.press(screen.getByLabelText("接続先を設定"));
  expect(mockOpenQr).toHaveBeenCalledTimes(1);
  await mailForm(screen);
  expect(screen.queryByLabelText("認証アプリのコード")).toBeNull();
  expect(requestMock.mock.calls.filter(([, path]) => path.endsWith("/complete"))).toHaveLength(0);
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("認証アプリのコード"), "123456");
  requestMock.mockResolvedValueOnce({ token: SESSION, sessionId: "device-1", ownerEmail: "owner@example.test", expiresAt: "2026-12-08T12:00:00Z" });
  await fireEvent.press(screen.getByLabelText("ログイン"));
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/login/complete", expect.objectContaining({
    body: expect.objectContaining({ challengeId: "challenge-1", emailCode: "12345678", totpCode: "123456", clientBinding: expect.any(String) }),
  }));
  expect(mockSave).toHaveBeenCalledWith(SESSION);
});

test("normalizes full pasted codes without native truncation, preserves leading zeros and supports back", async () => {
  const screen = await render(<RunnerLoginSettings />); await mailForm(screen);
  const mail = screen.getByLabelText("メール確認コード");
  expect(mail.props.maxLength).toBeUndefined();
  expect(mail.props.secureTextEntry).toBe(false);
  await fireEvent.changeText(mail, "０１２３ ４５６７");
  expect(screen.getByLabelText("メール確認コード").props.value).toBe("01234567");
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("認証アプリのコード"), "０１２ ３４５");
  expect(screen.getByLabelText("認証アプリのコード").props.value).toBe("012345");
  await fireEvent.press(screen.getByLabelText("メールコードを見直す"));
  expect(screen.getByLabelText("メール確認コード").props.value).toBe("01234567");
  expect(requestMock).toHaveBeenCalledTimes(1);
});

test("failed final verification retains the mail code and permits correcting it without resending", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  requestMock.mockRejectedValueOnce(new RunnerLoginError("invalid_authentication", 400));
  await fireEvent.press(screen.getByLabelText("ログイン"));
  expect(screen.getByRole("alert").props.children).toContain("最新メールの8桁");
  await fireEvent.press(screen.getByLabelText("メールコードを見直す"));
  expect(screen.getByLabelText("メール確認コード").props.value).toBe("12345678");
  expect(mockSave).not.toHaveBeenCalled();
});

test("expired mail cannot advance and clearly offers a resend", async () => {
  jest.useFakeTimers();
  const screen = await render(<RunnerLoginSettings />); await mailForm(screen);
  await act(async () => jest.advanceTimersByTime(600001));
  expect(screen.getByText("メールの期限が切れました。再送してください。")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("次へ"));
  expect(screen.queryByLabelText("認証アプリのコード")).toBeNull();
  expect(screen.getByLabelText("メールを再送").props.accessibilityState.disabled).toBe(false);
});

test("resending waits sixty seconds, reuses binding and returns to the mail step", async () => {
  jest.useFakeTimers();
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  const first = requestMock.mock.calls[0];
  await fireEvent.press(screen.getByLabelText("再送まで60秒"));
  expect(requestMock).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(60000));
  requestMock.mockResolvedValueOnce({ challengeId: "replacement", expiresAt: new Date(Date.now() + 600000).toISOString() });
  await fireEvent.press(screen.getByLabelText("メールを再送"));
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/login/start", first[2]);
  expect(screen.getByLabelText("メール確認コード").props.value).toBe("");
  expect(screen.queryByLabelText("認証アプリのコード")).toBeNull();
});

test("rejects shared token response and revokes an issued session if Keychain save fails", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  requestMock.mockResolvedValueOnce({ token: "legacy-runner-token" });
  await fireEvent.press(screen.getByLabelText("ログイン"));
  expect(mockSave).not.toHaveBeenCalled();
  mockSave.mockRejectedValueOnce(new Error("Keychain denied"));
  requestMock.mockResolvedValueOnce({ token: SESSION });
  await fireEvent.press(screen.getByLabelText("ログイン"));
  await waitFor(() => expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/logout", { token: SESSION, body: {} }));
  expect(screen.getByRole("alert")).toBeTruthy();
});

test("a login result after leaving the screen cannot publish credentials", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  let resolve!: (value: unknown) => void;
  requestMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await fireEvent.press(screen.getByLabelText("ログイン")); await screen.unmount();
  await act(async () => resolve({ token: SESSION }));
  expect(mockSave).not.toHaveBeenCalled();
});

test("settings confirm destructive action, then collect reauthentication and automatically retry the same device", async () => {
  signedIn();
  let deletes = 0;
  const base = requestMock.getMockImplementation()!;
  requestMock.mockImplementation(async (origin, path, options) => {
    if (path === "/auth/devices/other" && deletes++ === 0) throw new RunnerLoginError("reauthentication_required", 403);
    if (path === "/auth/reauth/start") return { challengeId: "reauth-1", expiresAt: new Date(Date.now() + 600000).toISOString() };
    return base(origin, path, options);
  });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<RunnerLoginSettings />);
  await waitFor(() => expect(screen.getByText("セキュリティ")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("別のMacの接続を解除"));
  expect(deletes).toBe(0);
  await act(async () => acceptAlert());
  await waitFor(() => expect(screen.getByLabelText("メール確認コード")).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText("メール確認コード"), "12345678");
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("認証アプリのコード"), "123456");
  await fireEvent.press(screen.getByLabelText("確認して接続を解除"));
  expect(requestMock).toHaveBeenCalledWith("https://runner.test", "/auth/reauth/complete", expect.objectContaining({ token: SESSION }));
  expect(deletes).toBe(2);
  expect(mockSave).not.toHaveBeenCalled();
  alert.mockRestore();
});

test("recovery keeps codes on screen until explicit save acknowledgement", async () => {
  const screen = await render(<RunnerLoginSettings />);
  await fireEvent.press(screen.getByLabelText("認証アプリを使えない場合")); await mailForm(screen);
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("復旧コード"), "one-use-recovery");
  requestMock.mockResolvedValueOnce({ recoveryId: "recovery-1", secret: "NEWSECRET", expiresAt: new Date(Date.now() + 600000).toISOString() });
  await fireEvent.press(screen.getByLabelText("認証アプリを再登録"));
  expect(screen.getByText("NEWSECRET")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("設定キーをコピー"));
  expect(mockCopy).toHaveBeenCalledWith("NEWSECRET");
  await fireEvent.changeText(screen.getByLabelText("新しい認証アプリのコード"), "987654");
  requestMock.mockResolvedValueOnce({ recoveryCodes: ["replacement-recovery-code"] });
  await fireEvent.press(screen.getByLabelText("登録を完了"));
  expect(screen.getByText("replacement-recovery-code")).toBeTruthy();
  expect(screen.queryByText("NEWSECRET")).toBeNull();
  await fireEvent.press(screen.getByLabelText("保存してログインへ"));
  expect(screen.queryByText("replacement-recovery-code")).toBeNull();
  expect(mockSave).not.toHaveBeenCalled();
});

test("recovery errors describe the factors on the current step", async () => {
  const screen = await render(<RunnerLoginSettings />);
  await fireEvent.press(screen.getByLabelText("認証アプリを使えない場合")); await mailForm(screen);
  await fireEvent.press(screen.getByLabelText("次へ"));
  await fireEvent.changeText(screen.getByLabelText("復旧コード"), "saved-code");
  requestMock.mockRejectedValueOnce(new RunnerLoginError("invalid_authentication", 400));
  await fireEvent.press(screen.getByLabelText("認証アプリを再登録"));
  expect(screen.getByRole("alert").props.children).toContain("保存した復旧コード");
  requestMock.mockResolvedValueOnce({ recoveryId: "recovery-1", secret: "NEWSECRET", expiresAt: new Date(Date.now() + 600000).toISOString() });
  await fireEvent.press(screen.getByLabelText("認証アプリを再登録"));
  await fireEvent.changeText(screen.getByLabelText("新しい認証アプリのコード"), "987654");
  requestMock.mockRejectedValueOnce(new RunnerLoginError("invalid_authentication", 400));
  await fireEvent.press(screen.getByLabelText("登録を完了"));
  expect(screen.getByRole("alert").props.children).toContain("新しく登録した認証アプリの6桁");
});

test("a settings confirmation left open after unmount cannot log out a replacement screen", async () => {
  signedIn();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<RunnerLoginSettings />);
  await fireEvent.press(screen.getByLabelText("この端末からログアウト"));
  await screen.unmount();
  await act(async () => acceptAlert());
  expect(mockSave).not.toHaveBeenCalled();
  alert.mockRestore();
});

test("logout cancellation changes nothing; confirmation removes local credentials before offline failure", async () => {
  signedIn();
  const base = requestMock.getMockImplementation()!;
  requestMock.mockImplementation(async (origin, path, options) => {
    if (path === "/auth/logout") throw new Error("offline");
    return base(origin, path, options);
  });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<RunnerLoginSettings />);
  await waitFor(() => expect(screen.getByText("owner@example.test")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("この端末からログアウト"));
  expect(mockSave).not.toHaveBeenCalled();
  await act(async () => acceptAlert());
  expect(mockSave).toHaveBeenCalledWith("");
  expect(alert).toHaveBeenLastCalledWith("この端末からログアウトしました", expect.stringContaining("未確認"));
  alert.mockRestore();
});
