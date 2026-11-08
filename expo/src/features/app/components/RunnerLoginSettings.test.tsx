import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { RunnerLoginSettings } from "./RunnerLoginSettings";
import { requestRunnerLogin } from "../utils/runnerLogin";
import { Alert } from "react-native";

const mockSave = jest.fn();
const mockOpenQr = jest.fn();
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
  requestMock.mockResolvedValue({ challengeId: "challenge-1", expiresAt: "2026-11-08T12:00:00Z" });
});

async function codeForm(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.changeText(screen.getByLabelText("メールアドレス"), "owner@example.test");
  await fireEvent.press(screen.getByLabelText("ログイン用メールを送る"));
  await fireEvent.changeText(screen.getByLabelText("メール確認コード"), "12345678");
  await fireEvent.changeText(screen.getByLabelText("Authenticatorコード"), "123456");
}

test("offers pairing and completes email plus TOTP without a manual shared token", async () => {
  const screen = await render(<RunnerLoginSettings />);
  expect(screen.queryByLabelText("Runnerトークン")).toBeNull();
  await fireEvent.press(screen.getByLabelText("接続設定QRを読み込む"));
  expect(mockOpenQr).toHaveBeenCalledTimes(1);
  await codeForm(screen);
  requestMock.mockResolvedValueOnce({ token: SESSION, sessionId: "device-1", ownerEmail: "owner@example.test", expiresAt: "2026-12-08T12:00:00Z" });
  await fireEvent.press(screen.getByLabelText("ログイン"));
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/login/complete", expect.objectContaining({
    body: expect.objectContaining({ challengeId: "challenge-1", emailCode: "12345678", totpCode: "123456", clientBinding: expect.any(String) }),
  }));
  expect(mockSave).toHaveBeenCalledWith(SESSION);
});

test("rejects a login response carrying a shared token", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  requestMock.mockResolvedValueOnce({ token: "legacy-runner-token" });
  await fireEvent.press(screen.getByLabelText("ログイン"));
  expect(mockSave).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
});

test("revokes an issued session when Keychain save fails", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
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
  await fireEvent.press(screen.getByLabelText("ログイン"));
  await screen.unmount();
  await act(async () => resolve({ token: SESSION }));
  expect(mockSave).not.toHaveBeenCalled();
});

test("other-device revocation can require reauthentication and never clears this session", async () => {
  mockSettings.runnerToken = SESSION;
  requestMock.mockImplementation(async (_origin, path) => {
    if (path === "/auth/session") return { sessionId: "self", ownerEmail: "owner@example.test", expiresAt: "2026-12-01T00:00:00Z" };
    if (path === "/auth/devices") return { devices: [{ id: "other", name: "紛失Mac", os: "macos", current: false }] };
    if (path === "/auth/devices/other") { const { RunnerLoginError } = jest.requireActual("../utils/runnerLogin"); throw new RunnerLoginError("reauthentication_required", 403); }
    if (path === "/auth/reauth/start") return { challengeId: "reauth-1", expiresAt: "2026-11-08T12:00:00Z" };
    return {};
  });
  const screen = await render(<RunnerLoginSettings />);
  await waitFor(() => expect(screen.getByText("紛失Mac")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("紛失Macを失効する"));
  expect(screen.getByText(/他の端末を失効するには/)).toBeTruthy();
  expect(mockSave).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("他の端末を管理するため本人確認"));
  await fireEvent.changeText(screen.getByLabelText("メール確認コード"), "12345678");
  await fireEvent.changeText(screen.getByLabelText("Authenticatorコード"), "123456");
  await fireEvent.press(screen.getByLabelText("本人確認を完了する"));
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/reauth/complete", expect.objectContaining({ token: SESSION }));
  expect(mockSave).not.toHaveBeenCalled();
});

test("recovery confirms a new Authenticator before displaying replacement recovery codes", async () => {
  const screen = await render(<RunnerLoginSettings />);
  await fireEvent.press(screen.getByLabelText("Authenticatorを紛失した場合"));
  await fireEvent.changeText(screen.getByLabelText("メールアドレス"), "owner@example.test");
  await fireEvent.press(screen.getByLabelText("復旧用メールを送る"));
  await fireEvent.changeText(screen.getByLabelText("メール確認コード"), "12345678");
  await fireEvent.changeText(screen.getByLabelText("復旧コード"), "one-use-recovery");
  requestMock.mockResolvedValueOnce({ recoveryId: "recovery-1", secret: "NEWSECRET", expiresAt: "2026-11-08T12:00:00Z" });
  await fireEvent.press(screen.getByLabelText("新しいAuthenticatorを登録する"));
  expect(screen.getByText("NEWSECRET")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("新しいAuthenticatorコード"), "987654");
  requestMock.mockResolvedValueOnce({ recoveryCodes: ["replacement-recovery-code"] });
  await fireEvent.press(screen.getByLabelText("復旧を完了する"));
  expect(screen.getByText("replacement-recovery-code")).toBeTruthy();
  expect(screen.queryByText("NEWSECRET")).toBeNull();
  expect(mockSave).not.toHaveBeenCalled();
});

test("offline logout deletes local credentials first and reports unconfirmed remote revocation", async () => {
  mockSettings.runnerToken = SESSION;
  requestMock.mockImplementation(async (_origin, path) => {
    if (path === "/auth/session") return { sessionId: "self", ownerEmail: "owner@example.test" };
    if (path === "/auth/devices") return { devices: [] };
    throw new Error("offline");
  });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<RunnerLoginSettings />);
  await fireEvent.press(screen.getByLabelText("この端末からログアウト"));
  expect(mockSave).toHaveBeenCalledWith("");
  expect(alert).toHaveBeenCalledWith("この端末からログアウトしました", expect.stringContaining("サーバーでの失効は確認できませんでした"));
  alert.mockRestore();
});

test("resending keeps the flow binding and replaces the challenge", async () => {
  const screen = await render(<RunnerLoginSettings />); await codeForm(screen);
  const first = requestMock.mock.calls.find(([, path]) => path === "/auth/login/start")!;
  requestMock.mockResolvedValueOnce({ challengeId: "replacement", expiresAt: "2026-11-08T12:00:00Z" });
  await fireEvent.press(screen.getByLabelText("コードを再送する"));
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.test", "/auth/login/start", first[2]);
});
