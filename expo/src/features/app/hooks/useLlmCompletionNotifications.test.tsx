import { act, renderHook } from "@testing-library/react-native";
import { useLlmCompletionNotifications } from "./useLlmCompletionNotifications";

test("keeps Backend identity while resolving and deduplicating completion notifications", async () => {
  const resolveSessionHistoryContext = jest.fn(() => ({ directoryDisplayName: "repo" }));
  const { result } = await renderHook(() => useLlmCompletionNotifications({
    handleForegroundSessionCompletion: () => false,
    resolveSessionHistoryContext,
  }));

  await act(async () => {
    result.current.pushNotification({
      backendId: "claude",
      sessionId: "same-session",
      threadId: "same-session",
      previewText: "Claude done",
      completedAtMs: 100,
    });
    result.current.pushNotification({
      backendId: "codex",
      sessionId: "same-session",
      threadId: "same-session",
      previewText: "Codex done",
      completedAtMs: 200,
    });
  });

  expect(resolveSessionHistoryContext).toHaveBeenNthCalledWith(1, "same-session", "claude");
  expect(resolveSessionHistoryContext).toHaveBeenNthCalledWith(2, "same-session", "codex");
  expect(result.current.notifications).toEqual([
    expect.objectContaining({ backendId: "codex", sessionId: "same-session" }),
    expect.objectContaining({ backendId: "claude", sessionId: "same-session" }),
  ]);
});
