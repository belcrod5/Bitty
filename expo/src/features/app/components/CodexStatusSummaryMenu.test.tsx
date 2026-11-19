import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { CodexStatusSummaryMenu } from "./CodexStatusSummaryMenu";
import { VisualThemeProvider } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualThemeId } from "../theme/visualThemes";
import type { CodexAuthRateLimit } from "../types/appTypes";

jest.mock("./AppModal", () => ({ AppModal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null }));
const mockSwitchAuthProfile = jest.fn();
const mockLoadAuthProfiles = jest.fn();
let mockUsageLimitReached = false;
let mockStatusText = "5h limit: 75% left\nWeekly limit: 50% left";
let mockWeeklyResetRemainingMs = (2 * 1440 + 21 * 60 + 24) * 60_000;
let mockStatusRateLimits: CodexAuthRateLimit[] | undefined;
let mockHasAuthProfiles = true;
jest.mock("../contexts/ChatDiagnosticsContext", () => ({
  useChatDiagnostics: () => ({
    codexCliStatusText: mockStatusText,
    codexCliStatusRateLimits: mockStatusRateLimits,
    codexUsageLimitReached: mockUsageLimitReached,
    codexCliStatusFetchedAtMs: Date.now(),
    codexCliStatusLoading: false,
    codexAuthProfileId: "account-1",
    codexAuthProfiles: mockHasAuthProfiles ? [
      {
        authId: "account-1",
        displayName: "仕事用",
        isCurrent: true,
        rateLimits: [
          { windowDurationMins: 300, usedPercent: 25, resetsAt: String((Date.now() / 1000) + 3600) },
          { windowDurationMins: 10080, usedPercent: 50, resetsAt: String(Date.now() + mockWeeklyResetRemainingMs) },
        ],
      },
      { authId: "account-2", displayName: "   ", isCurrent: false },
    ] : [],
    codexAuthProfilesLoading: false,
    codexAuthSwitching: false,
    codexAuthSwitchError: "",
    loadCodexAuthProfiles: mockLoadAuthProfiles,
    switchCodexAuthProfile: mockSwitchAuthProfile,
  }),
}));

describe("CodexStatusSummaryMenu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(View.prototype, "measureInWindow").mockImplementation((callback) => callback(0, 0, 100, 20));
    mockUsageLimitReached = false;
    mockStatusText = "5h limit: 75% left\nWeekly limit: 50% left";
    mockWeeklyResetRemainingMs = (2 * 1440 + 21 * 60 + 24) * 60_000;
    mockStatusRateLimits = undefined;
    mockHasAuthProfiles = true;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [2 * 86_400_000 + 3_600_000, "2日", false],
    [86_400_000, "1日", false],
    [86_400_000 - 1, "1日未", true],
  ] as const)("shows live reset %s ms in the closed footer without managed profiles", async (remainingMs, text, danger) => {
    jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    mockHasAuthProfiles = false;
    mockStatusRateLimits = [{ windowDurationMins: 10080, usedPercent: 50, resetsAt: String(Date.now() + remainingMs) }];
    const screen = await render(
      <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu />
      </VisualThemeProvider>
    );
    const footer = within(screen.getByLabelText("利用状況を更新して表示"));
    expect(footer.getByText(`5h 75% | 週 50% | ${text}`).props.numberOfLines).toBe(1);
    if (danger) expect(footer.getByText(text)).toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
    else expect(footer.getByText(text)).not.toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
    expect(screen.queryByText("/status")).toBeNull();
    expect(mockLoadAuthProfiles).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [{ windowDurationMins: 10080, usedPercent: 50, resetsAt: "invalid" }]])(
    "keeps unknown live reset data out of the footer: %s", async (rateLimits) => {
      mockStatusRateLimits = rateLimits;
      const screen = await render(<CodexStatusSummaryMenu />);
      const footer = within(screen.getByLabelText("利用状況を更新して表示"));
      expect(footer.getByText("5h 75% | 週 50%")).toBeTruthy();
      expect(footer.queryByText(/日/)).toBeNull();
    }
  );

  it("updates the closed footer to red when the live reset crosses below 24 hours", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 0, 1));
    mockHasAuthProfiles = false;
    mockStatusRateLimits = [{ windowDurationMins: 10080, usedPercent: 50, resetsAt: String(Date.now() + 86_400_000) }];
    const screen = await render(
      <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu />
      </VisualThemeProvider>
    );
    try {
      expect(within(screen.getByLabelText("利用状況を更新して表示")).getByText("1日")).toBeTruthy();
      await act(async () => { jest.advanceTimersByTime(30_000); });
      const footer = within(screen.getByLabelText("利用状況を更新して表示"));
      expect(footer.getByText("1日未")).toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
      expect(mockLoadAuthProfiles).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      jest.useRealTimers();
    }
  });

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
    expect(screen.getByText("5h 75% | 週 50% | 2日").props.numberOfLines).toBe(1);
    expect(screen.queryByText(/✓ 仕事用 \(/)).toBeNull();
    expect(screen.getByText("/status").parent?.props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ width: 320 }),
    ]));
    await fireEvent.press(screen.getByText("account-2"));
    await waitFor(() => expect(mockSwitchAuthProfile).toHaveBeenCalledWith("account-2"));
    expect(mockLoadAuthProfiles).toHaveBeenCalled();
  });

  it.each(["standard", "cyberpunk"] as const)("colors only a reset under one day red in %s", async (themeId) => {
    jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    mockWeeklyResetRemainingMs = 86_400_000 - 1;
    const screen = await render(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu />
      </VisualThemeProvider>
    );
    await fireEvent.press(screen.getByLabelText("利用状況を更新して表示"));
    await fireEvent.press(screen.getByLabelText("認証アカウントを切り替える"));
    expect(screen.getByText("1日未")).toHaveStyle({ color: VISUAL_THEMES[themeId].tones.danger.foreground });
    expect(screen.getByText("5h 75% | 週 50% | 1日未")).not.toHaveStyle({ color: VISUAL_THEMES[themeId].tones.danger.foreground });

    mockWeeklyResetRemainingMs = 86_400_000;
    await screen.rerender(
      <VisualThemeProvider themeId={themeId} onSelectTheme={() => undefined}>
        <CodexStatusSummaryMenu />
      </VisualThemeProvider>
    );
    expect(screen.getByText("1日")).not.toHaveStyle({ color: VISUAL_THEMES[themeId].tones.danger.foreground });
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
  mockStatusRateLimits = [{ windowDurationMins: 10080, usedPercent: 50, resetsAt: String(Date.now() + 3_600_000) }];
  const screen = await render(
    <VisualThemeProvider themeId="standard" onSelectTheme={() => undefined}>
      <CodexStatusSummaryMenu />
    </VisualThemeProvider>
  );
  expect(screen.getByLabelText("Codex 利用上限")).toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
  const footer = within(screen.getByLabelText("利用状況を更新して表示"));
  expect(footer.getByText("利用上限 | 1日未")).toBeTruthy();
  expect(footer.getByText("1日未")).toHaveStyle({ color: VISUAL_THEMES.standard.tones.danger.foreground });
});
