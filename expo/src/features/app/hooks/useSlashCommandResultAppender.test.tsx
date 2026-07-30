import { act, renderHook } from "@testing-library/react-native";
import type { ConversationMessage } from "../types/appTypes";
import { useSlashCommandResultAppender } from "./useSlashCommandResultAppender";

function message(partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">): ConversationMessage {
  return { content: "", ...partial };
}

function createHarness(params: {
  panelMessages?: ConversationMessage[];
  sessionMessagesById?: Record<string, ConversationMessage[]>;
}) {
  let builtCount = 0;
  const setConversationMessages = jest.fn();
  const options = {
    buildConversationMessage: (
      role: "user" | "assistant",
      content: string,
      buildOptions?: Partial<ConversationMessage>
    ): ConversationMessage => ({
      id: `built-${(builtCount += 1)}`,
      role,
      content,
      ...buildOptions,
    }),
    getConversationMessages: () => params.panelMessages || [],
    getConversationMessagesBySessionId: (sessionId: string) => (
      params.sessionMessagesById?.[sessionId] || []
    ),
    setConversationMessages,
  };
  return { options, setConversationMessages };
}

const baseConversation = [
  message({ id: "u1", role: "user", content: "こんにちは" }),
  message({ id: "a1", role: "assistant", content: "どうしましたか" }),
];

const runningCompactConversation = [
  ...baseConversation,
  message({ id: "u2", role: "user", content: "/compact" }),
  message({
    id: "a2",
    role: "assistant",
    content: "コンテキスト圧縮中です。完了まで待ってください。",
    llmStatusDetail: "slash command running: /compact",
  }),
];

describe("useSlashCommandResultAppender", () => {
  test("開始メッセージはユーザー+実行中assistantの2件を末尾へ追加しsessionId付きで書き込む", async () => {
    const harness = createHarness({
      sessionMessagesById: { "session-1": baseConversation },
    });
    const { result } = await renderHook(() => useSlashCommandResultAppender(harness.options));

    await act(async () => {
      result.current.appendSlashCommandProgress(
        "/compact",
        "コンテキスト圧縮中です。完了まで待ってください。",
        { panelId: "panel_1", sessionSnapshot: { sessionId: "session-1" } }
      );
    });

    expect(harness.setConversationMessages).toHaveBeenCalledTimes(1);
    const [conversationId, messages, writeOptions] = harness.setConversationMessages.mock.calls[0];
    expect(conversationId).toBe("panel_1");
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("/compact");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("コンテキスト圧縮中です。完了まで待ってください。");
    expect(messages[3].llmStatusDetail).toBe("slash command running: /compact");
    expect(writeOptions).toMatchObject({ isResponding: true, sessionId: "session-1" });
  });

  test("実行中メッセージが既にある場合の開始append再実行は重複追加しない", async () => {
    const harness = createHarness({
      sessionMessagesById: { "session-1": runningCompactConversation },
    });
    const { result } = await renderHook(() => useSlashCommandResultAppender(harness.options));

    await act(async () => {
      result.current.appendSlashCommandProgress(
        "/compact",
        "コンテキスト圧縮中です。完了まで待ってください。",
        { panelId: "panel_1", sessionSnapshot: { sessionId: "session-1" } }
      );
    });

    expect(harness.setConversationMessages).toHaveBeenCalledTimes(1);
    const [, messages, writeOptions] = harness.setConversationMessages.mock.calls[0];
    expect(messages.map((item: ConversationMessage) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(writeOptions).toMatchObject({ isResponding: true, sessionId: "session-1" });
  });

  test("完了メッセージは実行中メッセージを残したまま結果を追記する", async () => {
    const harness = createHarness({
      sessionMessagesById: { "session-1": runningCompactConversation },
    });
    const { result } = await renderHook(() => useSlashCommandResultAppender(harness.options));

    await act(async () => {
      result.current.appendSlashCommandResult(
        "/compact",
        "コンテキスト圧縮が完了しました。",
        { panelId: "panel_1", sessionSnapshot: { sessionId: "session-1" }, contextUsedPct: 12 }
      );
    });

    const [, messages, writeOptions] = harness.setConversationMessages.mock.calls[0];
    expect(messages).toHaveLength(5);
    expect(messages[4].role).toBe("assistant");
    expect(messages[4].content).toBe("コンテキスト圧縮が完了しました。");
    expect(messages[4].llmStatusDetail).toBe("slash command: /compact");
    expect(writeOptions).toMatchObject({
      contextUsedPct: 12,
      isResponding: false,
      sessionId: "session-1",
    });
  });

  test("セッション別メッセージが無い場合はパネルのメッセージへフォールバックする", async () => {
    const harness = createHarness({
      panelMessages: baseConversation,
      sessionMessagesById: {},
    });
    const { result } = await renderHook(() => useSlashCommandResultAppender(harness.options));

    await act(async () => {
      result.current.appendSlashCommandProgress(
        "/compact",
        "コンテキスト圧縮中です。完了まで待ってください。",
        { panelId: "panel_1", sessionSnapshot: { sessionId: "session-1" } }
      );
    });

    const [, messages] = harness.setConversationMessages.mock.calls[0];
    expect(messages.map((item: ConversationMessage) => item.id)).toEqual([
      "u1",
      "a1",
      "built-1",
      "built-2",
    ]);
  });
});
