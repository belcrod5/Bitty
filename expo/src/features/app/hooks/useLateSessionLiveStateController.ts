import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage, LlmSessionMessage } from "../types/appTypes";
import { deriveRestoredSessionThreadStatusType } from "../utils/sessionRestoreRuntimeSnapshot";
import type { RunnerSessionMessagesResult } from "./useLlmSessionExplorer";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

function shouldApplyLateLiveState(state: { threadStatusType?: string; hasRunningTurn: boolean }) {
  const status = String(state.threadStatusType || "").trim().toLowerCase();
  return state.hasRunningTurn || status === "active" || status.includes("approval");
}

type ApplyRestoredRuntime = (params: {
  restored: RunnerSessionMessagesResult;
  restoredMessages: LlmSessionMessage[];
  nextConversation: ConversationMessage[];
  nextSessionId: string;
  directory: string;
  effectiveContextUsedPct: number | null;
  restoreReplyRequestForThread: (sessionIdRaw: unknown, options?: { panelId?: string }) => boolean;
  setReply: (value: string) => void;
  panelId?: string;
}) => unknown;

export function useLateSessionLiveStateController(options: {
  activeSessionId: () => string;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  panelEntriesRef: MutableRefObject<Record<string, PanelRuntimeEntry>>;
  applyRestoredRuntime: ApplyRestoredRuntime;
  getRuntime: (sessionId: string) => {
    conversationMessages: ConversationMessage[];
    request?: { startedAtMs?: number } | null;
    executionGeneration?: number;
  } | null;
  upsertRuntime: (input: {
    sessionId: string;
    conversationMessages: ConversationMessage[];
    isResponding: boolean;
    selectedThreadStatusType: string;
    expectedRequestStartedAtMs?: number | null;
    clearRespondingRequestStartedAtMs?: number | null;
  }) => unknown;
  setPanelEntries: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>>;
  createPanelSnapshot: (
    panelId: string,
    base: PanelRuntimeSnapshot,
    patch: Partial<PanelRuntimeSnapshot>
  ) => PanelRuntimeSnapshot;
  setActiveThreadStatus: (status: string) => void;
  startRelay: (sessionId: string, options: {
    directory: string;
    startedAtMs?: number;
    resumeFromSeq: number;
    reason: string;
  }) => boolean;
  // 遅延liveメタが「実行中でない」(idle解決/取得失敗)で返ったときに呼ばれる。
  // restore時点のJSONLがターン途中の可能性がある(hadRunningBelief)場合、呼び出し側は
  // 1回のJSONL再取得で完了レース窓を閉じる(サイレントドロップ廃止、G2)。
  onLiveStateNotRunning?: (params: {
    sessionId: string;
    panelId: string;
    hadRunningBelief: boolean;
    reason: "idle" | "unavailable";
  }) => void;
  log: (event: string, payload: Record<string, unknown>, options: { throttleMs: number }) => void;
}) {
  const applyActive = useCallback((params: {
    restored: RunnerSessionMessagesResult;
    restoredMessages: LlmSessionMessage[];
    nextSessionId: string;
    directory: string;
    effectiveContextUsedPct: number | null;
    restoreReplyRequestForThread: (sessionIdRaw: unknown, options?: { panelId?: string }) => boolean;
    setReply: (value: string) => void;
    requestStartedAtMsAtRestoreApply: number | null;
    executionGenerationAtRestoreApply: number;
    isCurrent: () => boolean;
  }) => {
    if (!params.restored.liveStatePromise) return;
    void params.restored.liveStatePromise.then((liveState) => {
      if (!params.isCurrent()) return;
      if (!liveState || !shouldApplyLateLiveState(liveState)) {
        options.onLiveStateNotRunning?.({
          sessionId: params.nextSessionId,
          panelId: "",
          hadRunningBelief: params.requestStartedAtMsAtRestoreApply !== null,
          reason: liveState ? "idle" : "unavailable",
        });
        return;
      }
      const activeSessionId = options.activeSessionId();
      if (
        activeSessionId
        && activeSessionId !== params.nextSessionId
        && activeSessionId !== liveState.threadId
      ) return;
      const currentRequestStartedAtMs = Number(
        options.getRuntime(params.nextSessionId)?.request?.startedAtMs
      ) || null;
      if (currentRequestStartedAtMs !== params.requestStartedAtMsAtRestoreApply) return;
      const executionGeneration = Number(
        options.getRuntime(params.nextSessionId)?.executionGeneration
      ) || 0;
      if (executionGeneration !== params.executionGenerationAtRestoreApply) return;
      const restored = { ...params.restored, ...liveState, liveStatePromise: undefined };
      options.applyRestoredRuntime({
        restored,
        restoredMessages: params.restoredMessages,
        nextConversation: options.conversationMessagesRef.current,
        nextSessionId: params.nextSessionId,
        directory: params.directory,
        effectiveContextUsedPct: params.effectiveContextUsedPct,
        restoreReplyRequestForThread: params.restoreReplyRequestForThread,
        setReply: params.setReply,
        panelId: "",
      });
      options.setActiveThreadStatus(deriveRestoredSessionThreadStatusType(restored));
      options.log("session_restore_late_live_state_applied", {
        sessionId: params.nextSessionId,
        threadStatusType: restored.threadStatusType,
        hasRunningTurn: restored.hasRunningTurn,
      }, { throttleMs: 0 });
    });
  }, [options]);

  const applyPanel = useCallback((params: {
    restored: RunnerSessionMessagesResult;
    snapshot: PanelRuntimeSnapshot;
    panelId: string;
    directory: string;
    requestStartedAtMsAtHydrationStart: number | null;
    executionGenerationAtHydrationApply: number;
    isCurrent: () => boolean;
  }) => {
    if (!params.restored.liveStatePromise) return;
    void params.restored.liveStatePromise.then((liveState) => {
      if (!params.isCurrent()) return;
      if (!liveState || !shouldApplyLateLiveState(liveState)) {
        options.onLiveStateNotRunning?.({
          sessionId: params.snapshot.selectedSessionId,
          panelId: params.panelId,
          hadRunningBelief: params.requestStartedAtMsAtHydrationStart !== null,
          reason: liveState ? "idle" : "unavailable",
        });
        return;
      }
      const currentEntry = options.panelEntriesRef.current[params.panelId];
      if (currentEntry?.snapshot.selectedSessionId !== params.snapshot.selectedSessionId) return;
      const restored = { ...params.restored, ...liveState, liveStatePromise: undefined };
      const selectedThreadStatusType = deriveRestoredSessionThreadStatusType(restored);
      const currentRuntime = options.getRuntime(params.snapshot.selectedSessionId);
      if (
        (Number(currentRuntime?.executionGeneration) || 0) !== params.executionGenerationAtHydrationApply
      ) return;
      const runtime = options.upsertRuntime({
        sessionId: params.snapshot.selectedSessionId,
        conversationMessages: currentRuntime?.conversationMessages ?? params.snapshot.conversationMessages,
        isResponding: restored.hasRunningTurn,
        selectedThreadStatusType,
        expectedRequestStartedAtMs: params.requestStartedAtMsAtHydrationStart,
        clearRespondingRequestStartedAtMs: params.requestStartedAtMsAtHydrationStart,
      });
      if (!runtime) return;
      options.setPanelEntries((entries) => {
        const current = entries[params.panelId];
        if (current?.snapshot.selectedSessionId !== params.snapshot.selectedSessionId) return entries;
        return {
          ...entries,
          [params.panelId]: {
            ...current,
            snapshot: options.createPanelSnapshot(params.panelId, current.snapshot, {
              isResponding: restored.hasRunningTurn,
              selectedThreadStatusType,
            }),
          },
        };
      });
      if (restored.hasRunningTurn) {
        const runningStartedAtMs = Date.parse(String(restored.runningTurn?.startedAt || ""));
        options.startRelay(params.snapshot.selectedSessionId, {
          directory: params.directory,
          startedAtMs: Number.isFinite(runningStartedAtMs) ? runningStartedAtMs : Date.now(),
          resumeFromSeq: 0,
          reason: "session_restored_running_turn",
        });
      }
      options.log("panel_runtime_late_live_state_applied", {
        panelId: params.panelId,
        sessionId: params.snapshot.selectedSessionId,
        selectedThreadStatusType,
        hasRunningTurn: restored.hasRunningTurn,
      }, { throttleMs: 0 });
    });
  }, [options]);

  return { applyActive, applyPanel };
}
