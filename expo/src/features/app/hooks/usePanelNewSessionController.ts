import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import { createLlmSessionId } from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";

export type PanelRuntimeEntry = {
  sessionId?: string;
  snapshot: PanelRuntimeSnapshot;
};

type PanelRuntimeSnapshotPatch = Partial<Omit<PanelRuntimeSnapshot, "conversationMessages">> & {
  conversationMessages?: ConversationMessage[];
};

type UsePanelNewSessionControllerArgs = {
  registeredDirectories: { path: string; displayName: string }[];
  normalizedLlmDirectoryForRequest: () => string;
  normalizeRuntimePanelId: (panelId: unknown) => string;
  resolvePanelSnapshotForDisplay: (panelId: string) => PanelRuntimeSnapshot;
  createEmptyPanelRuntimeSnapshot: (panelId: string) => PanelRuntimeSnapshot;
  createPanelRuntimeSnapshot: (
    panelId: string,
    baseSnapshot: PanelRuntimeSnapshot,
    patch?: PanelRuntimeSnapshotPatch
  ) => PanelRuntimeSnapshot;
  setSessionMarkerColorForSession: (sessionId: string, markerColor: "gray") => void;
  upsertConversationRuntimeSnapshot: (input: {
    sessionId: string;
    conversationMessages: ConversationMessage[];
    contextUsedPct: number | null;
    isResponding: boolean;
    selectedThreadStatusType: string;
  }) => unknown;
  setPanelRuntimeEntriesById: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>>;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

function deriveDirectoryDisplayName(directory: string) {
  const segments = directory.split("/").filter(Boolean);
  return String(segments[segments.length - 1] || directory).trim();
}

export function usePanelNewSessionController({
  registeredDirectories,
  normalizedLlmDirectoryForRequest,
  normalizeRuntimePanelId,
  resolvePanelSnapshotForDisplay,
  createEmptyPanelRuntimeSnapshot,
  createPanelRuntimeSnapshot,
  setSessionMarkerColorForSession,
  upsertConversationRuntimeSnapshot,
  setPanelRuntimeEntriesById,
  logSessionDiag,
}: UsePanelNewSessionControllerArgs) {
  return useCallback((params: { panelId: string; directory: string }) => {
    const panelId = normalizeRuntimePanelId(params.panelId);
    if (!panelId) return "";
    const directory = parseLlmDirectory(params.directory || normalizedLlmDirectoryForRequest());
    const previousSnapshot = resolvePanelSnapshotForDisplay(panelId);

    const sessionId = createLlmSessionId();
    const directoryDisplayName = String(
      registeredDirectories.find((item) => parseLlmDirectory(item.path) === directory)?.displayName ||
      deriveDirectoryDisplayName(directory)
    ).trim();
    const snapshot = createPanelRuntimeSnapshot(panelId, createEmptyPanelRuntimeSnapshot(panelId), {
      selectedSessionId: sessionId,
      selectedDirectoryPath: directory,
      selectedDirectoryDisplayName: directoryDisplayName || directory,
      selectedSessionTitle: "（ユーザーメッセージなし）",
      selectedSessionMarkerColor: "gray",
      selectedThreadStatusType: "idle",
      modelRef: previousSnapshot.modelRef,
      reasoningEffort: previousSnapshot.reasoningEffort,
      contextUsedPct: null,
      isResponding: false,
      conversationMessages: [],
      scrollOffsetY: 0,
      scrollViewportHeight: 0,
      scrollNearBottom: true,
      ttsPlaybackMessageId: "",
    });

    setSessionMarkerColorForSession(sessionId, "gray");
    upsertConversationRuntimeSnapshot({
      sessionId,
      conversationMessages: [],
      contextUsedPct: null,
      isResponding: false,
      selectedThreadStatusType: "idle",
    });
    setPanelRuntimeEntriesById((prev) => ({
      ...prev,
      [panelId]: { sessionId, snapshot },
    }));
    logSessionDiag("panel_new_session_started", {
      panelId,
      previousSessionId: previousSnapshot.selectedSessionId || undefined,
      sessionId,
      directory,
    }, { throttleMs: 0 });
    return sessionId;
  }, [
    createEmptyPanelRuntimeSnapshot,
    createPanelRuntimeSnapshot,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    normalizeRuntimePanelId,
    registeredDirectories,
    resolvePanelSnapshotForDisplay,
    setPanelRuntimeEntriesById,
    setSessionMarkerColorForSession,
    upsertConversationRuntimeSnapshot,
  ]);
}
