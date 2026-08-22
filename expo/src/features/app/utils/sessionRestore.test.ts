import {
  buildHistoryFromSessionMessages,
  buildRestoredSessionState,
  clampContextUsedPct,
  mergeLocalCompactSlashMessages,
} from "./sessionRestore";
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
    olderCursor: null,
  };
}

describe("buildRestoredSessionState", () => {
  it("restores the Claude backend and model as one session identity", () => {
    const restored = buildRestoredResult([]);
    restored.backendId = "claude";
    restored.modelRef = "sonnet";

    const state = buildRestoredSessionState({
      restored,
      buildConversationMessage: buildConversationMessageStub,
      modelOptions: [{ backendId: "claude", modelId: "sonnet", label: "Claude Sonnet" }],
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "high",
      prevEffectiveSessionId: "previous-thread",
      nextSessionId: "thread-1",
    });

    expect(state).toMatchObject({ nextBackendId: "claude", nextModelRef: "sonnet", modelChanged: true });
  });

  it.each(["max", "ultra"] as const)("restores %s reasoning effort from the session", (restoredEffort) => {
    const restored = buildRestoredResult([]);
    restored.reasoningEffort = restoredEffort;

    const state = buildRestoredSessionState({
      restored,
      buildConversationMessage: buildConversationMessageStub,
      modelOptions: [],
      modelRef: "",
      reasoningEffort: "high",
      prevEffectiveSessionId: "previous-thread",
      nextSessionId: "thread-1",
    });

    expect(state.nextReasoningEffort).toBe(restoredEffort);
    expect(state.thinkChanged).toBe(true);
  });

  it("preserves goal context as an assistant-only display kind", () => {
    const restored = buildRestoredResult([
      {
        role: "assistant",
        content: "goal body",
        at: "2026-01-01T00:00:01.000Z",
        kind: "unclassified_context",
        inheritedFromParent: true,
      },
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

    expect(state.nextConversation[0]).toMatchObject({
      role: "assistant",
      content: "goal body",
      kind: "unclassified_context",
      inheritedFromParent: true,
    });
  });

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

describe("mergeLocalCompactSlashMessages", () => {
  const compactUser = (id: string, at: string): ConversationMessage => ({
    id,
    role: "user",
    content: "/compact",
    at,
  });
  const compactRunningAssistant = (id: string, at: string): ConversationMessage => ({
    id,
    role: "assistant",
    content: "コンテキスト圧縮中です。完了まで待ってください。",
    llmStatusDetail: "slash command running: /compact",
    at,
  });
  const restoredMessage = (id: string, role: "user" | "assistant", content: string, at: string): ConversationMessage => ({
    id,
    role,
    content,
    at,
  });

  it("JSONLに存在しないローカルの/compact開始ペアを復元結果へ引き継ぐ", () => {
    const restored = [
      restoredMessage("r1", "user", "こんにちは", "2026-01-01T00:00:01.000Z"),
      restoredMessage("r2", "assistant", "どうしましたか", "2026-01-01T00:00:02.000Z"),
    ];
    const local = [
      ...restored,
      compactUser("l1", "2026-01-01T00:00:03.000Z"),
      compactRunningAssistant("l2", "2026-01-01T00:00:04.000Z"),
    ];

    const merged = mergeLocalCompactSlashMessages(restored, local);

    expect(merged.map((item) => item.id)).toEqual(["r1", "r2", "l1", "l2"]);
  });

  it("復元結果へタイムスタンプ順で差し込む", () => {
    const restored = [
      restoredMessage("r1", "user", "こんにちは", "2026-01-01T00:00:01.000Z"),
      restoredMessage("r2", "assistant", "圧縮後の続き", "2026-01-01T00:00:10.000Z"),
    ];
    const local = [
      compactUser("l1", "2026-01-01T00:00:03.000Z"),
      compactRunningAssistant("l2", "2026-01-01T00:00:04.000Z"),
    ];

    const merged = mergeLocalCompactSlashMessages(restored, local);

    expect(merged.map((item) => item.id)).toEqual(["r1", "l1", "l2", "r2"]);
  });

  it("復元結果に同一メッセージがある場合は重複させない", () => {
    const restored = [
      restoredMessage("r1", "user", "こんにちは", "2026-01-01T00:00:01.000Z"),
      compactUser("r2", "2026-01-01T00:00:03.000Z"),
      compactRunningAssistant("r3", "2026-01-01T00:00:04.000Z"),
    ];
    const local = [
      restored[0],
      compactUser("l1", "2026-01-01T00:00:03.000Z"),
      compactRunningAssistant("l2", "2026-01-01T00:00:04.000Z"),
    ];

    const merged = mergeLocalCompactSlashMessages(restored, local);

    expect(merged.map((item) => item.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("ローカルに/compactメッセージが無ければ復元結果をそのまま返す", () => {
    const restored = [
      restoredMessage("r1", "user", "こんにちは", "2026-01-01T00:00:01.000Z"),
    ];
    const local = [
      restoredMessage("l1", "user", "別の発言", "2026-01-01T00:00:02.000Z"),
    ];

    expect(mergeLocalCompactSlashMessages(restored, local)).toBe(restored);
  });
});

describe("clampContextUsedPct", () => {
  it("keeps missing values null instead of coercing them to 0", () => {
    expect(clampContextUsedPct(null)).toBeNull();
    expect(clampContextUsedPct(undefined)).toBeNull();
    expect(clampContextUsedPct("")).toBeNull();
    expect(clampContextUsedPct("not-a-number")).toBeNull();
  });

  it("rounds and clamps real values into 0-100", () => {
    expect(clampContextUsedPct(41.6)).toBe(42);
    expect(clampContextUsedPct(0)).toBe(0);
    expect(clampContextUsedPct(-5)).toBe(0);
    expect(clampContextUsedPct(250)).toBe(100);
    expect(clampContextUsedPct("17")).toBe(17);
  });
});
