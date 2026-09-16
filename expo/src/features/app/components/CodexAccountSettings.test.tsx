import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { CodexAccountSettings } from "./CodexAccountSettings";
import { mergeCodexAuthRegistration } from "./CodexAccountSettings";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../keyboardController", () => { const { View } = require("react-native"); return { KeyboardAvoidingView: View }; });

test("merges status-only polling without losing registration details", () => {
  const previous = { authId: "account", registrationId: "reg", verificationUrl: "https://example.test", userCode: "ABC", expiresAt: "later", status: "pending" };
  expect(mergeCodexAuthRegistration(previous, { status: "completed" })).toEqual({ ...previous, status: "completed" });
});

const mockCtx: any = {
  codexAuthProfiles: [], loadCodexAuthProfiles: jest.fn(), switchCodexAuthProfile: jest.fn(),
  startCodexAuthRegistration: jest.fn(), completeCodexAuthRegistration: jest.fn(), getCodexAuthRegistration: jest.fn(),
  cancelCodexAuthRegistration: jest.fn(), reauthCodexAuthProfile: jest.fn(), deleteCodexAuthProfile: jest.fn(),
};
jest.mock("../contexts/ChatDiagnosticsContext", () => ({ useChatDiagnostics: () => mockCtx }));

beforeEach(() => {
  jest.resetAllMocks();
  mockCtx.codexAuthProfiles = [];
});

afterEach(cleanup);

test("loads profiles on mount", async () => {
  const screen = await render(<CodexAccountSettings />);
  expect(mockCtx.loadCodexAuthProfiles).toHaveBeenCalled();
  expect(screen.getByText("登録済みアカウントなし")).toBeTruthy();
  expect(screen.getByLabelText("Codexアカウントを追加").props.accessibilityState).toEqual({ disabled: false });
});

test("staged registration commits after entering save name", async () => {
  mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", authId: "new", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "authenticated", authId: "new" });
  mockCtx.completeCodexAuthRegistration.mockResolvedValue({ authId: "new", status: "completed" });
  mockCtx.switchCodexAuthProfile.mockResolvedValue(true);
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByLabelText("Codexアカウントを追加"));
  expect(screen.getByText("Codexアカウント認証")).toBeTruthy();
  await screen.findByPlaceholderText("例: 仕事用");
  expect(screen.getByLabelText("Codexアカウントを保存")).toBeTruthy();
  expect(mockCtx.completeCodexAuthRegistration).not.toHaveBeenCalled();
  await act(async () => { fireEvent.changeText(screen.getByPlaceholderText("例: 仕事用"), "New account"); });
  await fireEvent.press(screen.getByLabelText("Codexアカウントを保存"));
  await waitFor(() => expect(mockCtx.completeCodexAuthRegistration).toHaveBeenCalledWith("r", "New account"));
  expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("new");
  await waitFor(() => expect(screen.queryByPlaceholderText("例: 仕事用")).toBeNull());
});

test("completed inactive reauth does not switch account", async () => {
  mockCtx.codexAuthProfiles = [{ authId: "inactive", isCurrent: false }];
  mockCtx.reauthCodexAuthProfile.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "completed" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByLabelText("inactiveを再認証"));
  await waitFor(() => expect(mockCtx.loadCodexAuthProfiles).toHaveBeenCalledTimes(2));
  expect(mockCtx.switchCodexAuthProfile).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("閉じる")).toBeNull();
});

test("completed active reauth reinjects the active account", async () => {
  mockCtx.codexAuthProfiles = [{ authId: "active", isCurrent: true }];
  mockCtx.reauthCodexAuthProfile.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "completed" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByLabelText("activeを再認証"));
  await waitFor(() => expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("active"));
  expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("active");
  await waitFor(() => expect(screen.queryByLabelText("閉じる")).toBeNull());
});

test("authenticated registration can be cancelled without completing", async () => {
  mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "authenticated", authId: "new" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByLabelText("Codexアカウントを追加"));
  await screen.findByText("保存をやめる");
  await fireEvent.press(screen.getByLabelText("Codexアカウントの認証をキャンセル"));
  expect(mockCtx.cancelCodexAuthRegistration).toHaveBeenCalledWith("r");
  expect(mockCtx.completeCodexAuthRegistration).not.toHaveBeenCalled();
});

test("failed registration displays error code", async () => {
  mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "failed", errorCode: "revoked" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByLabelText("Codexアカウントを追加"));
  expect(await screen.findByText("failed (revoked)")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("閉じる"));
  expect(screen.queryByText("failed (revoked)")).toBeNull();
});

test("shows account details and disables deletion for the active account", async () => {
  mockCtx.codexAuthProfiles = [{
    authId: "active@example.com",
    displayName: "Active account",
    planType: "plus",
    status: "ready",
    isCurrent: true,
  }];

  const screen = await render(<CodexAccountSettings />);

  expect(screen.getByText("Active account")).toBeTruthy();
  expect(screen.getByText("plus・ready・使用中")).toBeTruthy();
  expect(screen.getByText("利用制限未取得")).toBeTruthy();
  expect(screen.getByLabelText("Active accountを削除").props.accessibilityState).toEqual({ disabled: true });
});

test("waits two seconds between pending registration polls", async () => {
  const screen = await render(<CodexAccountSettings />);
  jest.useFakeTimers();
  try {
    mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", status: "pending" });
    mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "pending" });

    await fireEvent.press(screen.getByLabelText("Codexアカウントを追加"));
    await act(async () => { await Promise.resolve(); });
    expect(mockCtx.getCodexAuthRegistration).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(1999));
    expect(mockCtx.getCodexAuthRegistration).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(1));
    expect(mockCtx.getCodexAuthRegistration).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
