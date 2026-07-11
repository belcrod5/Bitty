import { buildHistoryFromSessionMessages, buildRestoredSessionState } from "./sessionRestore";
import type { RunnerSessionMessagesResult } from "../hooks/useLlmSessionExplorer";
import type { ConversationMessage, LlmSessionMessage } from "../types/appTypes";

function buildConversationMessageStub(
  role: "user" | "assistant",
  content: string,
  opts?: { at?: string; commandExecution?: ConversationMessage["commandExecution"] }
): ConversationMessage {
  return {
    id: `${role}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    at: opts?.at,
    ...(opts?.commandExecution ? { commandExecution: opts.commandExecution } : {}),
  };
}

function buildRestoredResult(
  messages: RunnerSessionMessagesResult["messages"]
): RunnerSessionMessagesResult {
  return {
    threadId: "thread-1",
    sourceKind: "appServer",
    cwd: "/workspace",
    updatedAt: "2026-01-01T00:00:00.000Z",
    modelRef: "",
    reasoningEffort: "",
    latestToolLabel: "",
    messages,
    contextUsedPct: null,
    hasRunningTurn: false,
    runningTurn: null,
  };
}

describe("buildRestoredSessionState", () => {
  it("keeps commandExecution messages with empty content in restoredMessages and nextConversation", () => {
    const restored = buildRestoredResult([
      { role: "user", content: "run tests", at: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "",
        at: "2026-01-01T00:00:02.000Z",
        commandExecution: { command: "npm test", status: "completed", exitCode: 0 },
      },
      { role: "assistant", content: "done", at: "2026-01-01T00:00:03.000Z" },
    ]);

    const state = buildRestoredSessionState({
      restored,
      buildConversationMessage: buildConversationMessageStub,
      modelOptions: [],
      modelRef: "",
      reasoningEffort: "medium",
      prevEffectiveSessionId: "",
      nextSessionId: "thread-1",
    });

    expect(state.restoredMessages).toHaveLength(3);
    expect(state.restoredMessages[1]).toMatchObject({
      role: "assistant",
      content: "",
      commandExecution: { command: "npm test", status: "completed", exitCode: 0 },
    });

    expect(state.nextConversation).toHaveLength(3);
    expect(state.nextConversation[1].commandExecution).toEqual({
      command: "npm test",
      status: "completed",
      exitCode: 0,
    });
  });

  it("drops assistant messages with neither content nor commandExecution", () => {
    const restored = buildRestoredResult([
      { role: "assistant", content: "", at: "2026-01-01T00:00:01.000Z" },
    ]);

    const state = buildRestoredSessionState({
      restored,
      buildConversationMessage: buildConversationMessageStub,
      modelOptions: [],
      modelRef: "",
      reasoningEffort: "medium",
      prevEffectiveSessionId: "",
      nextSessionId: "thread-1",
    });

    expect(state.restoredMessages).toHaveLength(0);
    expect(state.nextConversation).toHaveLength(0);
  });
});

describe("buildHistoryFromSessionMessages", () => {
  it("ignores commandExecution messages so transcript/reply pairing stays intact", () => {
    const messages: LlmSessionMessage[] = [
      { role: "user", content: "run tests", at: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "",
        at: "2026-01-01T00:00:02.000Z",
        commandExecution: { command: "npm test", status: "completed", exitCode: 0 },
      },
      { role: "assistant", content: "done", at: "2026-01-01T00:00:03.000Z" },
    ];

    const history = buildHistoryFromSessionMessages(messages);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      transcript: "run tests",
      reply: "done",
    });
  });
});
