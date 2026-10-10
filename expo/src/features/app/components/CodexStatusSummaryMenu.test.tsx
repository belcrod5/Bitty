import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { CodexStatusSummaryMenu } from "./CodexStatusSummaryMenu";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualThemeId } from "../theme/visualThemes";

jest.mock("./AppModal", () => ({ AppModal: ({ children }: { children: ReactNode }) => children }));
const mockSwitchAuthProfile = jest.fn();
const mockRefreshStatus = jest.fn();
const mockLoadAuthProfiles = jest.fn();
let mockUsageLimitReached = false;
let mockStatusText = "5h limit: 75% left\nWeekly limit: 50% left";
jest.mock("../contexts/ChatDiagnosticsContext", () => ({
  useChatDiagnostics: () => ({
    codexCliStatusText: mockStatusText,
    codexUsageLimitReached: mockUsageLimitReached,
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
  beforeEach(() => {
    mockUsageLimitReached = false;
    mockStatusText = "5h limit: 75% left\nWeekly limit: 50% left";
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["standard", false],
    ["standard", true],
    ["cyberpunk", false],
    ["cyberpunk", true],
  ] as const)("uses %s theme colors for each limit (compact: %s)", async (themeId: VisualThemeId, compact) => {
    mockStatusText = "5h limit: 0% left\nWeekly limit: 10% left";
    const screen = await render(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu compact={compact} />
      </VisualThemeProvider>
    );
    const theme = VISUAL_THEMES[themeId];
    expect(screen.getByLabelText("5時間の残り 0%")).toHaveStyle({ color: theme.tones.danger.foreground });
    expect(screen.getByLabelText("週間の残り 10%")).toHaveStyle({ color: theme.tones.warning.foreground });

    mockStatusText = "5h limit: 1% left\nWeekly limit: 0% left";
    await screen.rerender(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu compact={compact} />
      </VisualThemeProvider>
    );
    expect(screen.getByLabelText("5時間の残り 1%")).toHaveStyle({ color: theme.tones.warning.foreground });
    expect(screen.getByLabelText("週間の残り 0%")).toHaveStyle({ color: theme.tones.danger.foreground });

    mockStatusText = "5h limit: 10% left\nWeekly limit: 10% left";
    await screen.rerender(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu compact={compact} />
      </VisualThemeProvider>
    );
    expect(screen.getByLabelText("5時間の残り 10%")).toHaveStyle({ color: theme.tones.warning.foreground });
    expect(screen.getByLabelText("週間の残り 10%")).toHaveStyle({ color: theme.tones.warning.foreground });

    mockStatusText = "5h limit: 11% left";
    await screen.rerender(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu compact={compact} />
      </VisualThemeProvider>
    );
    expect(screen.getByLabelText("5時間の残り 11%")).toHaveStyle({ color: theme.tones.neutral.foreground });
    expect(screen.getByLabelText("週間の残り --%")).toHaveStyle({ color: theme.tones.neutral.foreground });
  });

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

  it("shows compact limits on the board and keeps account switching available", async () => {
    mockSwitchAuthProfile.mockResolvedValue(true);
    const screen = await render(<CodexStatusSummaryMenu compact />);

    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.queryByText(/75% \| 50%/)).toBeNull();
    await fireEvent.press(screen.getByLabelText("利用状況を更新して表示"));
    await fireEvent.press(screen.getByLabelText("認証アカウントを切り替える"));
    await fireEvent.press(screen.getByText("account-2"));
    await waitFor(() => expect(mockSwitchAuthProfile).toHaveBeenCalledWith("account-2"));
  });
});


test("typed quota failure displays the red shared limit indicator even without percentage data", async () => {
  mockUsageLimitReached = true;
  mockStatusText = "Codex の利用上限に達しました。";
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <CodexStatusSummaryMenu />
    </VisualThemeProvider>
  );
  expect(screen.getByLabelText("Codex 利用上限")).toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
});
