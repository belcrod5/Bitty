import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { CodexStatusSummaryMenu } from "./CodexStatusSummaryMenu";

jest.mock("./AppModal", () => ({ AppModal: ({ children }: { children: ReactNode }) => children }));

describe("CodexStatusSummaryMenu", () => {
  it("uses the saved account name and shows remaining limits", async () => {
    const screen = await render(
      <CodexStatusSummaryMenu
        statusText={"5h limit: 75% left\nWeekly limit: 50% left"}
        statusFetchedAtMs={Date.now()}
        authProfileId="account-1"
        authProfiles={[
          {
            authId: "account-1",
            displayName: "仕事用",
            isCurrent: true,
            rateLimits: [{ windowDurationMins: 300, usedPercent: 25 }],
          },
          { authId: "account-2", displayName: "   ", isCurrent: false },
        ]}
      />,
    );

    expect(screen.getByText(/5h 75% \| 週 50%/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText("利用状況を更新して表示"));
    await waitFor(() => expect(screen.getByText("仕事用")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("認証アカウントを切り替える"));
    await waitFor(() => expect(screen.getByText(/✓ 仕事用 \(5h 75%\)/)).toBeTruthy());
    expect(screen.getByText("account-2")).toBeTruthy();
  });
});
