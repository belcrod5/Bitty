import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { CodexAccountSettings } from "./CodexAccountSettings";

const mockCtx: any = {
  codexAuthProfiles: [], loadCodexAuthProfiles: jest.fn(), switchCodexAuthProfile: jest.fn(),
  startCodexAuthRegistration: jest.fn(), getCodexAuthRegistration: jest.fn(),
  cancelCodexAuthRegistration: jest.fn(), reauthCodexAuthProfile: jest.fn(), deleteCodexAuthProfile: jest.fn(),
};
jest.mock("../contexts/ChatDiagnosticsContext", () => ({ useChatDiagnostics: () => mockCtx }));

beforeEach(() => {
  jest.resetAllMocks();
  mockCtx.codexAuthProfiles = [];
});

afterEach(cleanup);

test("loads profiles on mount", async () => {
  await render(<CodexAccountSettings />);
  expect(mockCtx.loadCodexAuthProfiles).toHaveBeenCalled();
});

test("completed new registration switches account", async () => {
  mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", authId: "new", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "completed" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.changeText(screen.getByPlaceholderText("アカウント名"), "new");
  await fireEvent.press(screen.getByText("アカウントを追加"));
  await waitFor(() => expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("new"));
});

test("completed inactive reauth does not switch account", async () => {
  mockCtx.codexAuthProfiles = [{ authId: "inactive", isCurrent: false }];
  mockCtx.reauthCodexAuthProfile.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "completed" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByText("再認証"));
  await waitFor(() => expect(mockCtx.loadCodexAuthProfiles).toHaveBeenCalledTimes(2));
  expect(mockCtx.switchCodexAuthProfile).not.toHaveBeenCalled();
});

test("completed active reauth reinjects the active account", async () => {
  mockCtx.codexAuthProfiles = [{ authId: "active", isCurrent: true }];
  mockCtx.reauthCodexAuthProfile.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "completed" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.press(screen.getByText("再認証"));
  await waitFor(() => expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("active"));
  expect(mockCtx.switchCodexAuthProfile).toHaveBeenCalledWith("active");
});

test("failed registration displays error code", async () => {
  mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", status: "pending" });
  mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "failed", errorCode: "revoked" });
  const screen = await render(<CodexAccountSettings />);
  await fireEvent.changeText(screen.getByPlaceholderText("アカウント名"), "x");
  await fireEvent.press(screen.getByText("アカウントを追加"));
  expect(await screen.findByText("failed (revoked)")).toBeTruthy();
});

test("waits two seconds between pending registration polls", async () => {
  const screen = await render(<CodexAccountSettings />);
  jest.useFakeTimers();
  try {
    mockCtx.startCodexAuthRegistration.mockResolvedValue({ registrationId: "r", status: "pending" });
    mockCtx.getCodexAuthRegistration.mockResolvedValue({ status: "pending" });

    await fireEvent.changeText(screen.getByPlaceholderText("アカウント名"), "new");
    await fireEvent.press(screen.getByText("アカウントを追加"));
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
