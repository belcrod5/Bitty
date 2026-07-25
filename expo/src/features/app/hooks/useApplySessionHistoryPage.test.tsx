import { useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react-native";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";
import { useApplySessionHistoryPage } from "./useApplySessionHistoryPage";

function message(itemId: string, inheritedFromParent = false): ConversationMessage {
  return {
    id: codexItemMessageId("thread-1", itemId),
    role: "assistant",
    content: itemId,
    inheritedFromParent: inheritedFromParent || undefined,
  };
}

function snapshot(): PanelRuntimeSnapshot {
  return {
    panelId: "panel-1",
    selectedSessionId: "thread-1",
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
    inheritedConversationMessages: [message("inherited-newer", true)],
    conversationMessages: [message("child-newer")],
  };
}

it("applies duplicate global rows to panels and keeps inherited rows before child rows", async () => {
  const globalConversation = [
    message("inherited-older", true),
    message("child-older"),
    message("inherited-newer", true),
    message("child-newer"),
  ];
  const upsertRuntime = jest.fn();
  const { result } = await renderHook(() => {
    const conversationMessagesRef = useRef(globalConversation);
    const [entries, setEntries] = useState<Record<string, PanelRuntimeEntry>>({
      "panel-1": { sessionId: "thread-1", snapshot: snapshot() },
    });
    const panelEntriesRef = useRef(entries);
    panelEntriesRef.current = entries;
    const apply = useApplySessionHistoryPage({
      activeSessionId: () => "thread-1",
      conversationMessagesRef,
      panelEntriesRef,
      setConversationMessages: jest.fn(),
      setPanelEntries: setEntries,
      getRuntime: () => null,
      upsertRuntime,
      createPanelSnapshot: (_panelId, base, patch) => ({ ...base, ...patch }),
      log: jest.fn(),
    });
    return { apply, entries };
  });

  await act(() => result.current.apply("thread-1", {
    threadId: "thread-1",
    sourceKind: "cli",
    cwd: "/workspace",
    updatedAt: "",
    modelRef: "",
    reasoningEffort: "",
    latestToolLabel: "",
    messages: [
      {
        role: "assistant",
        content: "inherited-older",
        at: "",
        itemId: "inherited-older",
        inheritedFromParent: true,
      },
      { role: "assistant", content: "child-older", at: "", itemId: "child-older" },
    ],
    contextUsedPct: null,
    hasRunningTurn: false,
    runningTurn: null,
    olderCursor: "cursor-2",
  }));

  expect(upsertRuntime).not.toHaveBeenCalled();
  expect(result.current.entries["panel-1"].snapshot.inheritedConversationMessages.map((item) => item.content))
    .toEqual(["inherited-older", "inherited-newer"]);
  expect(result.current.entries["panel-1"].snapshot.conversationMessages.map((item) => item.content))
    .toEqual(["child-older", "child-newer"]);
});
