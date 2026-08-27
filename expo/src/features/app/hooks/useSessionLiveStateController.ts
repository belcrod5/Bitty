import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { readCodexAppServerThread } from "../../codex/codexAppServerClient";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage, LlmSessionMessage } from "../types/appTypes";
import { deriveRestoredSessionThreadStatusType } from "../utils/sessionRestoreRuntimeSnapshot";
import type { RunnerSessionMessagesResult } from "./useLlmSessionExplorer";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

function shouldApplyLateLiveState(state: { threadStatusType?: string; hasRunningTurn: boolean }) {
  const status = String(state.threadStatusType || "").trim().toLowerCase();
  return state.hasRunningTurn || status === "active" || status.includes("approval");
}

function isConfirmedTerminalLiveState(state: {
  threadStatusType?: string;
  sessionState?: string;
  latestTurnStatus?: string;
  hasRunningTurn: boolean;
}) {
  if (shouldApplyLateLiveState(state)) return false;
  const values = [state.threadStatusType, state.sessionState, state.latestTurnStatus]
    .map((value) => String(value || "").trim().toLowerCase());
  return values.some((value) => (
    value === "idle"
    || value === "completed"
    || value === "interrupted"
    || value === "failed"
    || value === "system_error"
  ));
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

export function useSessionLiveStateController(options: {
  settingsLoaded: boolean;
  selectedSessionId: string;
  codexWsUrl: string;
  runnerToken: string;
  backendId: string;
  runnerWebSocketManager: RunnerWebSocketManager;
  resolveBackendId: (sessionId: string) => string;
  activeSessionId: () => string;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  panelEntriesRef: MutableRefObject<Record<string, PanelRuntimeEntry>>;
  applyRestoredRuntime: ApplyRestoredRuntime;
  getRuntime: (sessionId: string) => {
    conversationMessages: ConversationMessage[];
    request?: { startedAtMs?: number } | null;
    executionGeneration?: number;
    isResponding?: boolean;
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
  setActiveResponding: (isResponding: boolean) => void;
  setActiveThreadStatus: (status: string) => void;
  startRelay: (sessionId: string, options: {
    directory: string;
    startedAtMs?: number;
    ignoreWatermark?: boolean;
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
  const optionsRef = useRef(options);
  const selectedThreadStatusProbeSeqRef = useRef(0);
  optionsRef.current = options;
  const applyProbe = useCallback((params: {
    sessionId: string;
    liveState: {
      threadStatusType?: string;
      sessionState?: string;
      latestTurnStatus?: string;
      hasRunningTurn: boolean;
    };
    probeStartedAtMs: number;
  }) => {
    const currentOptions = optionsRef.current;
    const selectedThreadStatusType = String(
      params.liveState.threadStatusType || "unknown"
    ).trim() || "unknown";
    if (!isConfirmedTerminalLiveState(params.liveState)) {
      if (currentOptions.activeSessionId() === params.sessionId) {
        currentOptions.setActiveThreadStatus(selectedThreadStatusType);
      }
      return false;
    }
    const terminalThreadStatusType = (
      selectedThreadStatusType === "idle"
      || selectedThreadStatusType === "notLoaded"
      || selectedThreadStatusType === "systemError"
      || selectedThreadStatusType === "error"
    ) ? selectedThreadStatusType : "idle";
    const currentRuntime = currentOptions.getRuntime(params.sessionId);
    const currentRequestStartedAtMs = Number(currentRuntime?.request?.startedAtMs) || null;
    // A request created after this probe began was not represented by its result.
    // A responding runtime without a request identity is equally unsafe to clear.
    if (
      currentRuntime?.isResponding
      && (
        currentRequestStartedAtMs === null
        || currentRequestStartedAtMs >= params.probeStartedAtMs
      )
    ) {
      currentOptions.log("session_live_terminal_state_skipped", {
        sessionId: params.sessionId,
        reason: currentRequestStartedAtMs === null ? "missing_request_identity" : "request_started_after_probe",
        probeStartedAtMs: params.probeStartedAtMs,
        currentRequestStartedAtMs,
      }, { throttleMs: 0 });
      return false;
    }

    const conversationMessages = currentRuntime?.conversationMessages
      || Object.values(currentOptions.panelEntriesRef.current).find((entry) => (
        String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim() === params.sessionId
      ))?.snapshot.conversationMessages
      || (currentOptions.activeSessionId() === params.sessionId
        ? currentOptions.conversationMessagesRef.current
        : []);
    const runtime = currentOptions.upsertRuntime({
      sessionId: params.sessionId,
      conversationMessages,
      isResponding: false,
      selectedThreadStatusType: terminalThreadStatusType,
      expectedRequestStartedAtMs: currentRequestStartedAtMs,
      clearRespondingRequestStartedAtMs: currentRequestStartedAtMs,
    });
    if (!runtime) return false;
    const reconciledExecutionGeneration = Number(
      currentOptions.getRuntime(params.sessionId)?.executionGeneration
    ) || 0;

    currentOptions.setPanelEntries((entries) => {
      if (
        (Number(currentOptions.getRuntime(params.sessionId)?.executionGeneration) || 0)
        !== reconciledExecutionGeneration
      ) return entries;
      let changed = false;
      const next = { ...entries };
      for (const [panelId, entry] of Object.entries(entries)) {
        if (String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim() !== params.sessionId) continue;
        next[panelId] = {
          ...entry,
          snapshot: currentOptions.createPanelSnapshot(panelId, entry.snapshot, {
            isResponding: false,
            selectedThreadStatusType: terminalThreadStatusType,
          }),
        };
        changed = true;
      }
      return changed ? next : entries;
    });
    if (currentOptions.activeSessionId() === params.sessionId) {
      currentOptions.setActiveResponding(false);
      currentOptions.setActiveThreadStatus(terminalThreadStatusType);
    }
    currentOptions.log("session_live_terminal_state_applied", {
      sessionId: params.sessionId,
      selectedThreadStatusType: terminalThreadStatusType,
      clearedRequestStartedAtMs: currentRequestStartedAtMs,
      source: "thread_status_probe",
    }, { throttleMs: 0 });
    return true;
  }, []);

  useEffect(() => {
    if (!options.settingsLoaded) return;
    const currentOptions = optionsRef.current;
    const sessionId = String(currentOptions.activeSessionId() || "").trim();
    if (!sessionId || !options.codexWsUrl.trim()) {
      currentOptions.setActiveThreadStatus("unknown");
      return;
    }
    const probeSeq = selectedThreadStatusProbeSeqRef.current + 1;
    selectedThreadStatusProbeSeqRef.current = probeSeq;
    const probeStartedAtMs = Date.now();
    let cancelled = false;
    const probeBackendId = String(currentOptions.resolveBackendId(sessionId) || options.backendId || "codex")
      .trim() || "codex";
    currentOptions.log("thread_status_probe_start", {
      sessionId,
      backendId: probeBackendId,
      wsUrl: options.codexWsUrl.trim(),
    }, { throttleMs: 0 });
    void readCodexAppServerThread({
      wsUrl: options.codexWsUrl.trim(),
      wsToken: options.runnerToken,
      threadId: sessionId,
      timeoutMs: 25_000,
      runnerWebSocketManager: options.runnerWebSocketManager,
      backendId: probeBackendId,
      rawFallbackBackendId: "codex",
    })
      .then((restored) => {
        if (cancelled || selectedThreadStatusProbeSeqRef.current !== probeSeq) return;
        const runtimeReconciled = applyProbe({ sessionId, liveState: restored, probeStartedAtMs });
        optionsRef.current.log("thread_status_probe_done", {
          sessionId,
          threadStatusType: String(restored.threadStatusType || "unknown").trim() || "unknown",
          sessionState: restored.sessionState,
          latestTurnStatus: restored.latestTurnStatus,
          hasRunningTurn: restored.hasRunningTurn,
          runtimeReconciled,
        }, { throttleMs: 0 });
      })
      .catch((error) => {
        if (cancelled || selectedThreadStatusProbeSeqRef.current !== probeSeq) return;
        const latestOptions = optionsRef.current;
        latestOptions.log("thread_status_probe_failed", {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        }, { throttleMs: 0 });
        latestOptions.setActiveThreadStatus("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [
    applyProbe,
    options.backendId,
    options.runnerToken,
    options.codexWsUrl,
    options.runnerWebSocketManager,
    options.selectedSessionId,
    options.settingsLoaded,
  ]);

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
      const currentOptions = optionsRef.current;
      if (!params.isCurrent()) return;
      if (!liveState || !shouldApplyLateLiveState(liveState)) {
        currentOptions.onLiveStateNotRunning?.({
          sessionId: params.nextSessionId,
          panelId: "",
          hadRunningBelief: params.requestStartedAtMsAtRestoreApply !== null,
          reason: liveState ? "idle" : "unavailable",
        });
        return;
      }
      const activeSessionId = currentOptions.activeSessionId();
      if (
        activeSessionId
        && activeSessionId !== params.nextSessionId
        && activeSessionId !== liveState.threadId
      ) return;
      const currentRequestStartedAtMs = Number(
        currentOptions.getRuntime(params.nextSessionId)?.request?.startedAtMs
      ) || null;
      if (currentRequestStartedAtMs !== params.requestStartedAtMsAtRestoreApply) return;
      const executionGeneration = Number(
        currentOptions.getRuntime(params.nextSessionId)?.executionGeneration
      ) || 0;
      if (executionGeneration !== params.executionGenerationAtRestoreApply) return;
      const restored = { ...params.restored, ...liveState, liveStatePromise: undefined };
      currentOptions.applyRestoredRuntime({
        restored,
        restoredMessages: params.restoredMessages,
        nextConversation: currentOptions.conversationMessagesRef.current,
        nextSessionId: params.nextSessionId,
        directory: params.directory,
        effectiveContextUsedPct: params.effectiveContextUsedPct,
        restoreReplyRequestForThread: params.restoreReplyRequestForThread,
        setReply: params.setReply,
        panelId: "",
      });
      currentOptions.setActiveThreadStatus(deriveRestoredSessionThreadStatusType(restored));
      currentOptions.log("session_restore_late_live_state_applied", {
        sessionId: params.nextSessionId,
        threadStatusType: restored.threadStatusType,
        hasRunningTurn: restored.hasRunningTurn,
      }, { throttleMs: 0 });
    });
  }, []);

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
      const currentOptions = optionsRef.current;
      if (!params.isCurrent()) return;
      if (!liveState || !shouldApplyLateLiveState(liveState)) {
        currentOptions.onLiveStateNotRunning?.({
          sessionId: params.snapshot.selectedSessionId,
          panelId: params.panelId,
          hadRunningBelief: params.requestStartedAtMsAtHydrationStart !== null,
          reason: liveState ? "idle" : "unavailable",
        });
        return;
      }
      const currentEntry = currentOptions.panelEntriesRef.current[params.panelId];
      if (currentEntry?.snapshot.selectedSessionId !== params.snapshot.selectedSessionId) return;
      const restored = { ...params.restored, ...liveState, liveStatePromise: undefined };
      const selectedThreadStatusType = deriveRestoredSessionThreadStatusType(restored);
      const currentRuntime = currentOptions.getRuntime(params.snapshot.selectedSessionId);
      if (
        (Number(currentRuntime?.executionGeneration) || 0) !== params.executionGenerationAtHydrationApply
      ) return;
      const runtime = currentOptions.upsertRuntime({
        sessionId: params.snapshot.selectedSessionId,
        conversationMessages: currentRuntime?.conversationMessages ?? params.snapshot.conversationMessages,
        isResponding: restored.hasRunningTurn,
        selectedThreadStatusType,
        expectedRequestStartedAtMs: params.requestStartedAtMsAtHydrationStart,
        clearRespondingRequestStartedAtMs: params.requestStartedAtMsAtHydrationStart,
      });
      if (!runtime) return;
      currentOptions.setPanelEntries((entries) => {
        const current = entries[params.panelId];
        if (current?.snapshot.selectedSessionId !== params.snapshot.selectedSessionId) return entries;
        return {
          ...entries,
          [params.panelId]: {
            ...current,
            snapshot: currentOptions.createPanelSnapshot(params.panelId, current.snapshot, {
              isResponding: restored.hasRunningTurn,
              selectedThreadStatusType,
            }),
          },
        };
      });
      if (restored.hasRunningTurn) {
        const runningStartedAtMs = Date.parse(String(restored.runningTurn?.startedAt || ""));
        currentOptions.startRelay(params.snapshot.selectedSessionId, {
          directory: params.directory,
          startedAtMs: Number.isFinite(runningStartedAtMs) ? runningStartedAtMs : Date.now(),
          reason: "session_restored_running_turn",
          // 承認待ち復元はpending approvalのreplayが必要(seq≦watermarkは再送されない)。
          ignoreWatermark: selectedThreadStatusType === "waiting_approval",
        });
      }
      currentOptions.log("panel_runtime_late_live_state_applied", {
        panelId: params.panelId,
        sessionId: params.snapshot.selectedSessionId,
        selectedThreadStatusType,
        hasRunningTurn: restored.hasRunningTurn,
      }, { throttleMs: 0 });
    });
  }, []);

  return { applyActive, applyPanel, applyProbe };
}
