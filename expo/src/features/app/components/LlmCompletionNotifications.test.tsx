import { fireEvent, render } from "@testing-library/react-native";
import { LlmCompletionNotifications } from "./LlmCompletionNotifications";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

test("opens a completion notification with its Backend-qualified session reference", async () => {
  const onOpenSession = jest.fn();
  const view = await render(
    <LlmCompletionNotifications
      notifications={[{
        id: "claude:session-1:100",
        backendId: "claude",
        sessionId: "session-1",
        threadId: "session-1",
        directoryName: "repo",
        previewText: "done",
        completedAt: new Date(100).toISOString(),
      }]}
      visibleSessionIds={[]}
      onOpenSession={onOpenSession}
      onDismiss={jest.fn()}
    />
  );

  fireEvent.press(view.getByLabelText("完了した LLM セッションを開く"));

  expect(onOpenSession).toHaveBeenCalledWith({
    backendId: "claude",
    sessionId: "session-1",
  });
});
