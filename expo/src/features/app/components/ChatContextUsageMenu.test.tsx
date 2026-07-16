import { render } from "@testing-library/react-native";
import { ChatContextUsageMenu } from "./ChatContextUsageMenu";

function renderMenu(contextPctText: string) {
  return render(
    <ChatContextUsageMenu
      contextPctText={contextPctText}
      directoryPath="/workspace"
      progress={0}
      progressColor="#0284c7"
      trackColor="#dbeafe"
      onStartNewSession={jest.fn()}
    />
  );
}

describe("ChatContextUsageMenu", () => {
  it("shows the placeholder as-is while context usage is not fetched yet", async () => {
    const { getByText, queryByText } = await renderMenu("--");

    expect(getByText("--")).toBeTruthy();
    expect(queryByText("--%")).toBeNull();
  });

  it("shows a fetched context usage percentage", async () => {
    const { getByText } = await renderMenu("42%");

    expect(getByText("42%")).toBeTruthy();
  });
});
