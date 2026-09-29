import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { CodexStatusSummaryMenu } from "./CodexStatusSummaryMenu";

jest.mock("./AppModal", () => ({ AppModal: ({ children }: { children: ReactNode }) => children }));
const mockSwitchAuthProfile = jest.fn();
const mockRefreshStatus = jest.fn();
const mockLoadAuthProfiles = jest.fn();
jest.mock("../contexts/ChatDiagnosticsContext", () => ({
  useChatDiagnostics: () => ({
    codexCliStatusText: "5h limit: 75% left\nWeekly limit: 50% left",
    codexCliStatusFetchedAtMs: Date.now(),
    codexCliStatusLoading: false,
    codexAuthProfileId: "account-1",
    codexAuthProfiles: [
      {
        authId: "account-1",
        displayName: "仕事用",
        isCurrent: true,
        rateLimits: [
          { windowDurationMins: 300, usedPercent: 25, resetsAt: String((Date.now() / 1000) + 3600) },
          { windowDurationMins: 10080, usedPercent: 50, resetsAt: String((Date.now() / 1000) + (2 * 1440 + 21 * 60 + 24) * 60) },
        ],
      },
      { authId: "account-2", displayName: "   ", isCurrent: false },
    ],
    codexAuthProfilesLoading: false,
    codexAuthSwitching: false,
    codexAuthSwitchError: "",
    refreshCodexCliStatus: mockRefreshStatus,
    loadCodexAuthProfiles: mockLoadAuthProfiles,
    switchCodexAuthProfile: mockSwitchAuthProfile,
  }),
}));

describe("CodexStatusSummaryMenu", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses the saved account name and shows remaining limits", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    jest.spyOn(Date, "now").mockReturnValue(nowMs);
    mockSwitchAuthProfile.mockResolvedValue(false);
    const screen = await render(<CodexStatusSummaryMenu />);

    expect(screen.getByText(/5h 75% \| 週 50%/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("利用状況を更新して表示"));
    await waitFor(() => expect(screen.getByText("仕事用")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("認証アカウントを切り替える"));
    await waitFor(() => expect(screen.getByText("✓ 仕事用")).toBeTruthy());
    expect(screen.getByText("5h 75% | 週 50% | 2日21:24").props.numberOfLines).toBe(1);
    expect(screen.queryByText(/✓ 仕事用 \(/)).toBeNull();
    expect(screen.getByText("/status").parent?.props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ width: 320 }),
    ]));
    await fireEvent.press(screen.getByText("account-2"));
    await waitFor(() => expect(mockSwitchAuthProfile).toHaveBeenCalledWith("account-2"));
    expect(mockLoadAuthProfiles).toHaveBeenCalled();
  });
});
