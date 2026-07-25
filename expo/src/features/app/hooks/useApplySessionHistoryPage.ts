import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RunnerSessionMessagesResult } from "./useLlmSessionExplorer";
import type { ConversationRuntimeSnapshot } from "./useConversationRuntimeStoreController";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import {
  buildRestoredPanelConversation,
  prependConversationMessages,
} from "../utils/sessionRestoreRuntimeSnapshot";

export function useApplySessionHistoryPage(options: {
  activeSessionId: () => string;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  panelEntriesRef: MutableRefObject<Record<string, PanelRuntimeEntry>>;
  setConversationMessages: (messages: ConversationMessage[]) => void;
  setPanelEntries: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>>;
  getRuntime: (sessionId: string) => ConversationRuntimeSnapshot | null;
  upsertRuntime: (input: { sessionId: string; conversationMessages: ConversationMessage[] }) => unknown;
  createPanelSnapshot: (
    panelId: string,
    base: PanelRuntimeSnapshot,
    patch: {
      inheritedConversationMessages: ConversationMessage[];
      conversationMessages: ConversationMessage[];
    }
  ) => PanelRuntimeSnapshot;
  log: (event: string, payload: Record<string, unknown>, options: { throttleMs: number }) => void;
}) {
  return useCallback((sessionId: string, page: RunnerSessionMessagesResult) => {
    const active = options.activeSessionId();
    const runtime = options.getRuntime(sessionId);
    const panelSnapshot = Object.values(options.panelEntriesRef.current)
      .map((entry) => entry.snapshot)
      .find((snapshot) => String(snapshot.selectedSessionId || "").trim() === sessionId);
    const current = active === sessionId
      ? options.conversationMessagesRef.current
      : runtime?.conversationMessages || panelSnapshot?.conversationMessages || [];
    const older = buildRestoredPanelConversation({
      messages: page.messages,
      panelId: "history",
      sessionId,
    });
    const olderInherited = older.filter((message) => message.inheritedFromParent === true);
    const olderConversation = older.filter((message) => message.inheritedFromParent !== true);
    const merged = prependConversationMessages(older, current);
    const globalChanged = merged.length !== current.length;
    if (globalChanged) {
      options.upsertRuntime({ sessionId, conversationMessages: merged });
      if (active === sessionId) options.setConversationMessages(merged);
    }
    options.setPanelEntries((entries) => {
      let changed = false;
      const next = { ...entries };
      for (const [panelId, entry] of Object.entries(entries)) {
        if (String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim() !== sessionId) continue;
        const inheritedConversationMessages = prependConversationMessages(
          olderInherited,
          entry.snapshot.inheritedConversationMessages
        );
        const conversationMessages = prependConversationMessages(
          olderConversation,
          entry.snapshot.conversationMessages
        );
        if (
          inheritedConversationMessages.length === entry.snapshot.inheritedConversationMessages.length
          && conversationMessages.length === entry.snapshot.conversationMessages.length
        ) {
          continue;
        }
        changed = true;
        next[panelId] = {
          ...entry,
          snapshot: options.createPanelSnapshot(panelId, entry.snapshot, {
            inheritedConversationMessages,
            conversationMessages,
          }),
        };
      }
      return changed ? next : entries;
    });
    options.log("session_history_page_prepended", {
      sessionId,
      addedMessageCount: merged.length - current.length,
      totalMessageCount: merged.length,
      olderPageAvailable: Boolean(page.olderCursor),
    }, { throttleMs: 0 });
  }, [options]);
}
