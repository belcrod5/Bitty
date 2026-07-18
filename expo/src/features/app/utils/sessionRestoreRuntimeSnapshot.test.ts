import {
  buildRestoredPanelConversation,
  buildRestoredSessionRuntimeSnapshot,
  projectRestoredRuntimeStatusToConversation,
} from "./sessionRestoreRuntimeSnapshot";
import { codexItemMessageId } from "./codexItemMessageId";
import type { RunnerSessionMessage, RunnerSessionMessagesResult } from "../hooks/useLlmSessionExplorer";
import type { ConversationMessage, LlmSessionMessage } from "../types/appTypes";

const commandExecution = {
  command: "npm test",
  status: "completed" as const,
  exitCode: 0,
};

function message(partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">): ConversationMessage {
  return { content: "", ...partial };
}

function buildRestoredResult(overrides: Partial<RunnerSessionMessagesResult> = {}): RunnerSessionMessagesResult {
  return {
    threadId: "thread-1",
    sourceKind: "appServer",
    cwd: "/workspace",
    updatedAt: "2026-01-01T00:00:00.000Z",
    modelRef: "",
    reasoningEffort: "",
    latestToolLabel: "",
    messages: [],
    contextUsedPct: null,
    hasRunningTurn: false,
    runningTurn: null,
    ...overrides,
  };
}

describe("buildRestoredPanelConversation", () => {
  const restoredMessages: RunnerSessionMessage[] = [
    { role: "user", content: "hello", at: "2026-01-01T00:00:01.000Z", itemId: "item-1" },
    { role: "assistant", content: "hi", at: "2026-01-01T00:00:02.000Z", itemId: "item-2" },
    { role: "assistant", content: "", at: "2026-01-01T00:00:03.000Z", itemId: "item-3", commandExecution },
  ];

  it("derives deterministic ids from item ids so rehydration keeps message ids unchanged", () => {
    const first = buildRestoredPanelConversation({
      messages: restoredMessages,
      panelId: "panel-a",
      sessionId: "thread-1",
    });
    const second = buildRestoredPanelConversation({
      messages: restoredMessages,
      panelId: "panel-b",
      sessionId: "thread-1",
    });

    expect(first.map((item) => item.id)).toEqual([
      codexItemMessageId("thread-1", "item-1"),
      codexItemMessageId("thread-1", "item-2"),
      codexItemMessageId("thread-1", "item-3"),
    ]);
    // 同じセッションなら別パネル・別ハイドレーションでもIDは不変。
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(first[2].commandExecution).toEqual(commandExecution);
  });

  it("falls back to index-based ids for messages without item ids or with duplicate item ids", () => {
    const conversation = buildRestoredPanelConversation({
      messages: [
        { role: "user", content: "no item id", at: "" },
        { role: "assistant", content: "first", at: "", itemId: "item-1" },
        { role: "assistant", content: "duplicate", at: "", itemId: "item-1" },
      ],
      panelId: "panel-a",
      sessionId: "thread-1",
    });

    expect(conversation.map((item) => item.id)).toEqual([
      "panel-panel-a-thread-1-0-user",
      codexItemMessageId("thread-1", "item-1"),
      "panel-panel-a-thread-1-2-assistant",
    ]);
  });
});

describe("projectRestoredRuntimeStatusToConversation", () => {
  it("stamps the running status on the last text assistant message, not a trailing command row", () => {
    const conversation = [
      message({ id: "u1", role: "user", content: "run tests" }),
      message({ id: "a1", role: "assistant", content: "running now" }),
      message({ id: "c1", role: "assistant", commandExecution }),
    ];

    const next = projectRestoredRuntimeStatusToConversation({
      conversation,
      restored: { hasRunningTurn: true, threadStatusType: "active", runningTurn: null },
      fallbackMessageId: "fallback-1",
      buildConversationMessage: (role, content, extra) => ({
        id: "built",
        role,
        content,
        ...extra,
      }),
    });

    expect(next.find((item) => item.id === "a1")?.llmStatus).toBe("model_processing");
    expect(next.find((item) => item.id === "c1")?.llmStatus).toBeUndefined();
    expect(next.find((item) => item.id === "c1")?.commandExecution).toEqual(commandExecution);
  });
});

describe("buildRestoredSessionRuntimeSnapshot", () => {
  it("derives latestAssistantText from the last text assistant message, skipping trailing command rows", () => {
    const restoredMessages: LlmSessionMessage[] = [
      { role: "user", content: "run tests", at: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "done", at: "2026-01-01T00:00:02.000Z" },
      { role: "assistant", content: "", at: "2026-01-01T00:00:03.000Z", commandExecution },
    ];

    const snapshot = buildRestoredSessionRuntimeSnapshot({
      restored: buildRestoredResult(),
      restoredMessages,
      nextConversation: [],
      nextSessionId: "thread-1",
      sessionResumeAutoSignalMaxAgeMs: 60_000,
      restoreReplyRequestForThread: () => false,
    });

    expect(snapshot.latestAssistantText).toBe("done");
  });
});
