import {
  applyPanelHydrationSnapshot,
  applyPanelHydrationStart,
  resolvePanelConversationAfterHydration,
  RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS,
  shouldPreserveRuntimeConversationOnHydrate,
} from "./panelHydrationFreshness";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";

const NOW_MS = 1_700_000_000_000;

function buildInput(overrides: Partial<Parameters<typeof shouldPreserveRuntimeConversationOnHydrate>[0]> = {}) {
  return {
    runtimeMessageCount: 3,
    runtimeUpdatedAtMs: NOW_MS,
    runtimeIsResponding: false,
    runtimeRequestStartedAtMs: 100,
    requestStartedAtMsAtHydrationStart: 100,
    requestCompletedAtMs: null,
    restoredHasRunningTurn: true,
    restoredUpdatedAtMs: null,
    restoredMessageCount: 3,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function message(partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">): ConversationMessage {
  return { content: "", ...partial };
}

function panelSnapshot(panelId: string, sessionId: string, content: string): PanelRuntimeSnapshot {
  return {
    panelId,
    selectedSessionId: sessionId,
    selectedDirectoryPath: "/workspace",
    selectedDirectoryDisplayName: "workspace",
    selectedSessionTitle: "session",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "none",
    selectedThreadStatusType: "idle",
    modelRef: "",
    reasoningEffort: "",
    contextUsedPct: null,
    isResponding: false,
    inheritedConversationMessages: [],
    conversationMessages: [message({ id: `${panelId}-message`, role: "assistant", content })],
  };
}

function startHydration(
  entries: Parameters<typeof applyPanelHydrationStart>[0]["entries"],
  sessionId: string,
  emptySnapshot: PanelRuntimeSnapshot
) {
  return applyPanelHydrationStart({
    entries,
    panelId: "target",
    sessionId,
    emptySnapshot,
    directory: "/workspace",
    directoryDisplayName: "workspace",
    titleHint: "",
    updatedAtHint: "",
    modelRefHint: "",
    reasoningEffortHint: "",
    contextUsedPctHint: null,
  });
}

describe("applyPanelHydrationStart", () => {
  it("reads the latest panel state and keeps TTS progress through terminal reconciliation", () => {
    const staleSnapshot = panelSnapshot("target", "session-1", "done");
    const latestMessage = message({
      id: "playing-id",
      role: "assistant",
      content: "done",
      ttsWaveform: [0.2, 0.8],
    });
    const latestSnapshot = {
      ...staleSnapshot,
      selectedThreadStatusType: "active",
      isResponding: true,
      requestStartedAtMs: 100,
      conversationMessages: [latestMessage],
      ttsPlaybackMessageId: "playing-id",
    };
    const other = { sessionId: "session-2", snapshot: panelSnapshot("other", "session-2", "untouched") };
    const started = startHydration({
      target: { sessionId: "session-1", snapshot: latestSnapshot },
      other,
    }, "session-1", staleSnapshot);

    expect(started.target.snapshot).toMatchObject({
      isHydrating: true,
      isResponding: true,
      requestStartedAtMs: 100,
      selectedThreadStatusType: "active",
      conversationMessages: [latestMessage],
      ttsPlaybackMessageId: "playing-id",
    });
    expect(started.other).toBe(other);

    const terminal = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: 100,
      restoredConversation: [message({ id: "restored-id", role: "assistant", content: "done" })],
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: NOW_MS,
      restoredMessageCount: 1,
      panelConversation: started.target.snapshot.conversationMessages,
      ttsPlaybackMessageId: started.target.snapshot.ttsPlaybackMessageId || "",
      nowMs: NOW_MS,
    });
    expect(terminal.conversationMessages).toEqual([latestMessage]);
    expect(terminal.ttsPlaybackMessageId).toBe("playing-id");
  });

  it("starts empty for an explicit session switch and leaves other panels untouched", () => {
    const oldSnapshot = {
      ...panelSnapshot("target", "session-1", "old session"),
      ttsPlaybackMessageId: "old-message",
    };
    const emptySnapshot = {
      ...panelSnapshot("target", "", ""),
      selectedSessionId: "",
      conversationMessages: [],
      ttsPlaybackMessageId: "",
    };
    const other = { sessionId: "session-3", snapshot: panelSnapshot("other", "session-3", "untouched") };
    const started = startHydration({
      target: { sessionId: "session-1", snapshot: oldSnapshot },
      other,
    }, "session-2", emptySnapshot);

    expect(started.target.snapshot).toMatchObject({
      selectedSessionId: "session-2",
      selectedThreadStatusType: "loading",
      isHydrating: true,
      isResponding: false,
      conversationMessages: [],
      ttsPlaybackMessageId: "",
    });
    expect(started.other).toBe(other);
  });
});

describe("shouldPreserveRuntimeConversationOnHydrate", () => {
  it("returns false when runtime has no messages, regardless of other conditions", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeMessageCount: 0,
      runtimeIsResponding: true,
      requestCompletedAtMs: NOW_MS,
      restoredUpdatedAtMs: 0,
      restoredMessageCount: 0,
    }));
    expect(result).toBe(false);
  });

  it("returns true when a live turn is responding, even if other conditions are unfavorable", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeIsResponding: true,
      requestCompletedAtMs: null,
      runtimeUpdatedAtMs: 0,
      restoredUpdatedAtMs: NOW_MS + 1_000_000,
      restoredMessageCount: 999,
    }));
    expect(result).toBe(true);
  });

  it("uses a terminal server snapshot instead of stale responding runtime", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredHasRunningTurn: false,
      runtimeIsResponding: true,
      requestCompletedAtMs: NOW_MS,
      runtimeUpdatedAtMs: NOW_MS + 1_000,
    }));
    expect(result).toBe(false);
  });

  it("does not let completion grace override a terminal server snapshot", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredHasRunningTurn: false,
      requestCompletedAtMs: NOW_MS,
    }));
    expect(result).toBe(false);
  });

  it("preserves a different request that started while terminal history was loading", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredHasRunningTurn: false,
      runtimeRequestStartedAtMs: 200,
      requestStartedAtMsAtHydrationStart: 100,
    }));
    expect(result).toBe(true);
  });

  it("returns true when the request completed exactly at the grace boundary", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      requestCompletedAtMs: NOW_MS - RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS,
    }));
    expect(result).toBe(true);
  });

  it("falls through to the next check when the completion grace has just elapsed", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      requestCompletedAtMs: NOW_MS - RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS - 1,
      restoredUpdatedAtMs: NOW_MS + 1,
      runtimeUpdatedAtMs: NOW_MS,
    }));
    expect(result).toBe(false);
  });

  it("prefers runtime when its updatedAtMs is greater than or equal to restored (timestamp comparison)", () => {
    const greater = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS,
      restoredUpdatedAtMs: NOW_MS - 1,
    }));
    expect(greater).toBe(true);

    const equal = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS,
      restoredUpdatedAtMs: NOW_MS,
    }));
    expect(equal).toBe(true);
  });

  it("returns false when restored updatedAtMs is newer than runtime", () => {
    const result = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      runtimeUpdatedAtMs: NOW_MS - 1,
      restoredUpdatedAtMs: NOW_MS,
    }));
    expect(result).toBe(false);
  });

  it("falls back to message count comparison when both timestamps are missing", () => {
    const preserved = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredUpdatedAtMs: null,
      runtimeMessageCount: 5,
      restoredMessageCount: 5,
    }));
    expect(preserved).toBe(true);

    const replaced = shouldPreserveRuntimeConversationOnHydrate(buildInput({
      restoredUpdatedAtMs: null,
      runtimeMessageCount: 2,
      restoredMessageCount: 5,
    }));
    expect(replaced).toBe(false);
  });
});

describe("resolvePanelConversationAfterHydration", () => {
  it("keeps live runtime while the server still reports a running turn", () => {
    const runtimeMessage = message({ id: "runtime", role: "assistant", content: "streaming" });
    const result = resolvePanelConversationAfterHydration({
      runtime: {
        conversationMessages: [runtimeMessage],
        updatedAtMs: NOW_MS,
        isResponding: true,
        requestStartedAtMs: 100,
        requestCompletedAtMs: null,
        selectedThreadStatusType: "active",
      },
      requestStartedAtMsAtHydrationStart: 100,
      restoredConversation: [message({ id: "restored", role: "assistant", content: "older" })],
      restoredHasRunningTurn: true,
      restoredThreadStatusType: "active",
      restoredUpdatedAtMs: NOW_MS - 1,
      restoredMessageCount: 1,
      panelConversation: [runtimeMessage],
      ttsPlaybackMessageId: "runtime",
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      conversationMessages: [runtimeMessage],
      isResponding: true,
      selectedThreadStatusType: "active",
      ttsPlaybackMessageId: "runtime",
      preserveRuntimeConversation: true,
    });
  });

  it("uses running server history when no live runtime exists", () => {
    const restoredMessage = message({ id: "restored", role: "assistant", content: "working" });
    const result = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: null,
      restoredConversation: [restoredMessage],
      restoredHasRunningTurn: true,
      restoredThreadStatusType: "active",
      restoredUpdatedAtMs: NOW_MS,
      restoredMessageCount: 1,
      panelConversation: [],
      ttsPlaybackMessageId: "",
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      conversationMessages: [restoredMessage],
      isResponding: true,
      selectedThreadStatusType: "active",
      preserveRuntimeConversation: false,
    });
  });

  it("keeps exact matching message ids, waveform, and playback target", () => {
    const result = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: 100,
      restoredConversation: [
        message({ id: "restored-user", role: "user", content: "hello" }),
        message({ id: "restored-assistant", role: "assistant", content: "done" }),
      ],
      panelConversation: [
        message({ id: "panel-user", role: "user", content: "hello" }),
        message({ id: "panel-assistant", role: "assistant", content: "done", ttsWaveform: [0.1, 0.2] }),
      ],
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: NOW_MS,
      restoredMessageCount: 2,
      ttsPlaybackMessageId: "panel-assistant",
      nowMs: NOW_MS,
    });

    expect(result.conversationMessages).toEqual([
      message({ id: "panel-user", role: "user", content: "hello" }),
      message({ id: "panel-assistant", role: "assistant", content: "done", ttsWaveform: [0.1, 0.2] }),
    ]);
    expect(result.ttsPlaybackMessageId).toBe("panel-assistant");
  });

  it("matches duplicate content by occurrence and drops local placeholders", () => {
    const result = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: 100,
      restoredConversation: [
        message({ id: "restored-1", role: "assistant", content: "same" }),
        message({ id: "restored-2", role: "assistant", content: "same" }),
      ],
      panelConversation: [
        message({ id: "panel-1", role: "assistant", content: "same", ttsWaveform: [1] }),
        message({ id: "placeholder", role: "assistant", content: "" }),
        message({ id: "panel-2", role: "assistant", content: "same", ttsWaveform: [2] }),
      ],
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: NOW_MS,
      restoredMessageCount: 2,
      ttsPlaybackMessageId: "placeholder",
      nowMs: NOW_MS,
    });

    expect(result.conversationMessages.map((item) => item.id)).toEqual(["panel-1", "panel-2"]);
    expect(result.conversationMessages.map((item) => item.ttsWaveform)).toEqual([[1], [2]]);
    expect(result.ttsPlaybackMessageId).toBe("");
  });

  it("does not match command rows to text messages or different commands", () => {
    const result = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: 100,
      restoredConversation: [
        message({
          id: "restored-command",
          role: "assistant",
          commandExecution: { command: "npm test", status: "completed", exitCode: 0 },
        }),
      ],
      panelConversation: [
        message({ id: "text", role: "assistant", content: "" }),
        message({
          id: "other-command",
          role: "assistant",
          commandExecution: { command: "npm test", status: "failed", exitCode: 1 },
        }),
      ],
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: NOW_MS,
      restoredMessageCount: 1,
      ttsPlaybackMessageId: "other-command",
      nowMs: NOW_MS,
    });

    expect(result.conversationMessages[0].id).toBe("restored-command");
    expect(result.ttsPlaybackMessageId).toBe("");
  });
});

describe("applyPanelHydrationSnapshot", () => {
  const target = { sessionId: "session-1", snapshot: panelSnapshot("target", "session-1", "old") };
  const other = { sessionId: "session-2", snapshot: panelSnapshot("other", "session-2", "untouched") };
  const restored = panelSnapshot("target", "session-1", "restored");

  it("updates only the requested panel when panel, session, and request generation still match", () => {
    const result = applyPanelHydrationSnapshot({
      entries: { target, other },
      panelId: "target",
      sessionId: "session-1",
      snapshot: restored,
      expectedRequestStartedAtMs: null,
      currentRequestStartedAtMs: null,
    });

    expect(result.target.snapshot).toBe(restored);
    expect(result.other).toBe(other);
  });

  it("keeps every panel unchanged after the target panel switches sessions", () => {
    const switchedSnapshot = {
      ...panelSnapshot("target", "session-3", "new session"),
      ttsPlaybackMessageId: "new-session-message",
    };
    const switched = { sessionId: "session-3", snapshot: switchedSnapshot };
    const entries = { target: switched, other };
    const result = applyPanelHydrationSnapshot({
      entries,
      panelId: "target",
      sessionId: "session-1",
      snapshot: restored,
      expectedRequestStartedAtMs: null,
      currentRequestStartedAtMs: null,
    });

    expect(result).toBe(entries);
    expect(result.target.snapshot).toBe(switchedSnapshot);
    expect(result.target.snapshot.ttsPlaybackMessageId).toBe("new-session-message");
    expect(result.other).toBe(other);
  });

});
