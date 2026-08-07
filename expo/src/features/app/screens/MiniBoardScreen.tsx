import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { ChatScreen } from "./ChatScreen";
import { useAppShell } from "../contexts/AppShellContext";
import { useChatDiagnostics } from "../contexts/ChatDiagnosticsContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import { useConversation } from "../contexts/ConversationContext";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { styles } from "../styles";
import { CodexStatusSummaryMenu } from "../components/CodexStatusSummaryMenu";
import { MiniBoardChatPreviewSkeleton } from "../components/MiniBoardChatPreviewSkeleton";
import { PopupChatOverlay } from "../components/PopupChatOverlay";
import type { PopupChatSourceRect } from "../components/popupChatTypes";
import type { DirectoryMarkerColor } from "../types/directorySessions";
import { RunnerWsConnectionStatus, type RunnerWsDataSyncStatus } from "../../runnerWs/RunnerWsConnectionStatus";
import { miniBoardStyles } from "./MiniBoardScreen.styles";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import {
  buildPanelHydrationRequestMark,
  decidePanelHydration,
  snapshotHoldsAssignedSession,
  type PanelHydrationRequestMark,
} from "../utils/panelAssignmentHydration";

const MINI_BOARD_SOURCE_LABEL = "registered_directories";
const MINI_BOARD_PREVIEW_PANEL_IDS = [
  "mini_preview_1",
  "mini_preview_2",
  "mini_preview_3",
  "mini_preview_4",
  "mini_preview_5",
  "mini_preview_6",
] as const;
const MINI_BOARD_POPUP_PANEL_IDS = [
  "mini_popup_1",
  "mini_popup_2",
  "mini_popup_3",
  "mini_popup_4",
  "mini_popup_5",
  "mini_popup_6",
] as const;
type MiniBoardPreviewPanelId = typeof MINI_BOARD_PREVIEW_PANEL_IDS[number];
type MiniBoardPopupPanelId = typeof MINI_BOARD_POPUP_PANEL_IDS[number];
const MINI_BOARD_PANEL_ASSIGNMENT: Array<{
  panelId: MiniBoardPreviewPanelId;
  popupPanelId: MiniBoardPopupPanelId;
  sessionIndex: number;
}> = MINI_BOARD_PREVIEW_PANEL_IDS.map((panelId, index) => ({
  panelId,
  popupPanelId: MINI_BOARD_POPUP_PANEL_IDS[index],
  sessionIndex: index,
}));
const MINI_BOARD_ALL_PANEL_IDS = [
  ...MINI_BOARD_PREVIEW_PANEL_IDS,
  ...MINI_BOARD_POPUP_PANEL_IDS,
];
type MiniBoardPanelHydrationState = {
  status: "idle" | "loading" | "ready" | "error";
  sessionId: string;
  message: string;
};

const MINI_BOARD_MARKER_OPTIONS: { value: DirectoryMarkerColor; label: string; color: string }[] = [
  { value: "gray", label: "灰", color: "#8b8b84" },
  { value: "red", label: "赤", color: "#c84d42" },
  { value: "yellow", label: "黄", color: "#c68e26" },
  { value: "green", label: "緑", color: "#31884b" },
  { value: "black", label: "黒", color: "#25335c" },
  { value: "none", label: "なし", color: "#ffffff" },
];
const MINI_BOARD_DEFAULT_COLOR_FILTERS = MINI_BOARD_MARKER_OPTIONS.map((item) => item.value);

function createMiniBoardCycleId() {
  return `mini-board-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, "0")}`;
}

function parseMiniBoardMarkerColor(raw: unknown): DirectoryMarkerColor {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "gray" || value === "red" || value === "yellow" || value === "green" || value === "black") return value;
  return "none";
}

export function MiniBoardScreen() {
  const { height: windowHeight } = useWindowDimensions();
  const previewCardHeight = Math.max(120, Math.floor((windowHeight - 170) / 4));
  const [openPopupPanelId, setOpenPopupPanelId] = useState<MiniBoardPopupPanelId | null>(null);
  const [popupSourceRect, setPopupSourceRect] = useState<PopupChatSourceRect | null>(null);
  const [hiddenPopupSourcePanelId, setHiddenPopupSourcePanelId] = useState<MiniBoardPreviewPanelId | null>(null);
  const [selectedColorFilters, setSelectedColorFilters] = useState<DirectoryMarkerColor[]>(() => (
    [...MINI_BOARD_DEFAULT_COLOR_FILTERS]
  ));
  const [colorFilterPickerOpen, setColorFilterPickerOpen] = useState(false);
  const [colorFilterPickerRendered, setColorFilterPickerRendered] = useState(false);
  const { openDrawer } = useAppShell();
  const { runnerRouteSelection } = useChatScreen();
  const {
    codexCliStatusText,
    codexCliStatusFetchedAtMs,
    codexCliStatusLoading,
    codexAuthProfileId,
    codexAuthProfiles,
    codexAuthProfilesLoading,
    codexAuthSwitching,
    codexAuthSwitchError,
    refreshCodexCliStatus,
    loadCodexAuthProfiles,
    switchCodexAuthProfile,
  } = useChatDiagnostics();
  const {
    registeredDirectories,
    directorySessionsById,
    directorySessionSync,
    sessionMarkerColorsById,
    ensureRegisteredDirectorySessions,
    refreshRegisteredDirectorySessions,
    showChatBottomToast,
    markSessionRead,
    logSessionDiag,
  } = useConversation();
  const {
    clearPanelSnapshot,
    copyPanelSnapshot,
    hydratePanelFromSessionHistory,
  } = usePanelRuntimeController();
  const { getSnapshot } = usePanelRuntimeStore();
  const logSessionDiagRef = useRef(logSessionDiag);
  const clearPanelSnapshotRef = useRef(clearPanelSnapshot);
  const hydratePanelFromSessionHistoryRef = useRef(hydratePanelFromSessionHistory);
  const getSnapshotRef = useRef(getSnapshot);
  const openPopupPanelIdRef = useRef<MiniBoardPopupPanelId | null>(null);
  const colorFilterPickerAnimRef = useRef(new Animated.Value(0));
  const colorFilterPickerAnimationIdRef = useRef(0);
  const miniBoardCycleIdRef = useRef(createMiniBoardCycleId());
  const previewCardRefs = useRef<Record<string, View | null>>({});
  // 同一マウント内で発行済みのhydrate要求(進行中含む)のパネル別記録。
  // アンマウントでリセットされるが、再入場時は共有ストアのsnapshot鮮度
  // (decidePanelHydration)で差分だけ再取得される。
  const lastRequestedHydrationByPanelRef = useRef<Record<string, PanelHydrationRequestMark>>({});
  const [panelHydrationById, setPanelHydrationById] = useState<Record<MiniBoardPreviewPanelId, MiniBoardPanelHydrationState>>(() => (
    MINI_BOARD_PREVIEW_PANEL_IDS.reduce((acc, panelId) => {
      acc[panelId] = {
        status: "idle",
        sessionId: "",
        message: "未初期化",
      };
      return acc;
    }, {} as Record<MiniBoardPreviewPanelId, MiniBoardPanelHydrationState>)
  ));
  const panelRows = useMemo(() => {
    const rows: Array<typeof MINI_BOARD_PANEL_ASSIGNMENT> = [];
    for (let index = 0; index < MINI_BOARD_PANEL_ASSIGNMENT.length; index += 2) {
      rows.push(MINI_BOARD_PANEL_ASSIGNMENT.slice(index, index + 2));
    }
    return rows;
  }, []);

  useEffect(() => {
    logSessionDiagRef.current = logSessionDiag;
    clearPanelSnapshotRef.current = clearPanelSnapshot;
    hydratePanelFromSessionHistoryRef.current = hydratePanelFromSessionHistory;
    getSnapshotRef.current = getSnapshot;
    openPopupPanelIdRef.current = openPopupPanelId;
  });

  // ポップアップパネルのsnapshotだけを後始末する(closePopupと同じ扱い)。
  // previewパネルのsnapshotは共有ストアに保持し、再入場時の全量再取得を避ける。
  const clearPopupPanelSnapshots = () => {
    MINI_BOARD_POPUP_PANEL_IDS.forEach((panelId) => {
      if (!String(getSnapshotRef.current(panelId).selectedSessionId || "").trim()) return;
      clearPanelSnapshotRef.current(panelId);
    });
  };

  const allRegisteredDirectorySessionCandidates = useMemo(() => {
    return collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById);
  }, [directorySessionsById, registeredDirectories]);
  const registeredDirectorySessionCandidates = useMemo(() => {
    if (selectedColorFilters.length <= 0) return [];
    const selectedColorFilterSet = new Set(selectedColorFilters);
    return allRegisteredDirectorySessionCandidates.filter((entry) => (
      selectedColorFilterSet.has(parseMiniBoardMarkerColor(sessionMarkerColorsById[entry.sessionId]))
    ));
  }, [allRegisteredDirectorySessionCandidates, selectedColorFilters, sessionMarkerColorsById]);
  const selectedFilterOptions = useMemo(() => (
    MINI_BOARD_MARKER_OPTIONS.filter((option) => selectedColorFilters.includes(option.value))
  ), [selectedColorFilters]);
  const filterTriggerDots = useMemo(() => {
    if (selectedFilterOptions.length === MINI_BOARD_MARKER_OPTIONS.length) {
      return ["yellow", "red", "green"]
        .map((value) => MINI_BOARD_MARKER_OPTIONS.find((option) => option.value === value))
        .filter((option): option is typeof MINI_BOARD_MARKER_OPTIONS[number] => !!option);
    }
    return selectedFilterOptions.length > 0
      ? selectedFilterOptions.slice(0, 3)
      : MINI_BOARD_MARKER_OPTIONS.filter((option) => option.value === "none");
  }, [selectedFilterOptions]);
  const colorFilterPickerAnimatedStyle = useMemo(() => ({
    opacity: colorFilterPickerAnimRef.current,
    transform: [
      {
        translateX: colorFilterPickerAnimRef.current.interpolate({
          inputRange: [0, 1],
          outputRange: [18, 0],
        }),
      },
      {
        scale: colorFilterPickerAnimRef.current.interpolate({
          inputRange: [0, 1],
          outputRange: [0.96, 1],
        }),
      },
    ],
  }), []);
  const candidateDebugSnapshot = useMemo(() => ({
    source: MINI_BOARD_SOURCE_LABEL,
    registeredDirectoryCount: registeredDirectories.length,
    selectedColorFilters,
    unfilteredCandidateCount: allRegisteredDirectorySessionCandidates.length,
    candidateCount: registeredDirectorySessionCandidates.length,
    directorySample: registeredDirectories.slice(0, 8).map((directory) => ({
      id: directory.id,
      path: directory.path,
      displayName: directory.displayName,
      sessionCount: directorySessionsById[directory.id]?.entries.length || 0,
      loaded: directorySessionsById[directory.id]?.loaded || false,
      loading: directorySessionsById[directory.id]?.loading || false,
      error: directorySessionsById[directory.id]?.error || "",
    })),
    candidateSample: registeredDirectorySessionCandidates.slice(0, 8).map((entry) => ({
      sessionId: entry.sessionId,
      directory: entry.directory,
      directoryDisplayName: entry.directoryDisplayName,
      cwd: entry.cwd,
      title: entry.firstUserMessage,
      markerColor: parseMiniBoardMarkerColor(sessionMarkerColorsById[entry.sessionId]),
      updatedAt: entry.updatedAt,
      contextUsedPct: entry.contextUsedPct,
      modelRef: entry.modelRef,
      reasoningEffort: entry.reasoningEffort,
    })),
  }), [
    allRegisteredDirectorySessionCandidates.length,
    directorySessionsById,
    registeredDirectories,
    registeredDirectorySessionCandidates,
    selectedColorFilters,
    sessionMarkerColorsById,
  ]);
  const miniBoardDataSync = useMemo<RunnerWsDataSyncStatus>(() => {
    const directoryStates = registeredDirectories
      .map((directory) => directorySessionsById[directory.id])
      .filter((state) => !!state);
    const lastFetchedAtMs = directoryStates.reduce((max, state) => {
      const fetchedAtMs = Number(state.fetchedAtMs || 0);
      return Number.isFinite(fetchedAtMs) && fetchedAtMs > max ? fetchedAtMs : max;
    }, 0);
    const expectedAssignments = MINI_BOARD_PANEL_ASSIGNMENT.filter((assignment) => (
      !!registeredDirectorySessionCandidates[assignment.sessionIndex]
    ));
    const panelLoadingCount = expectedAssignments.filter((assignment) => {
      const hydrationState = panelHydrationById[assignment.panelId];
      return !hydrationState || hydrationState.status === "idle" || hydrationState.status === "loading";
    }).length;
    const panelErrorCount = expectedAssignments.filter((assignment) => (
      panelHydrationById[assignment.panelId]?.status === "error"
    )).length;
    const staleCount = expectedAssignments.filter((assignment) => {
      const candidate = registeredDirectorySessionCandidates[assignment.sessionIndex];
      const hydrationState = panelHydrationById[assignment.panelId];
      return hydrationState?.status === "ready" && hydrationState.sessionId !== candidate?.sessionId;
    }).length;
    const directorySyncActive = (
      directorySessionSync.phase === "loading" ||
      directorySessionSync.phase === "refreshing"
    );
    const loadingCount = directorySyncActive
      ? directorySessionSync.pendingCount + directorySessionSync.activeCount
      : panelLoadingCount;
    const errorCount = directorySessionSync.failedCount + panelErrorCount;
    const base = {
      totalCount: expectedAssignments.length,
      loadingCount,
      staleCount,
      errorCount,
      lastUpdatedAtMs: lastFetchedAtMs,
    };
    if (registeredDirectories.length <= 0) {
      return {
        ...base,
        status: "unknown",
        label: "同期不明",
        detail: "登録ディレクトリなし",
        totalCount: 0,
      };
    }
    if (loadingCount > 0) {
      return {
        ...base,
        status: "loading",
        label: directorySyncActive ? "同期中" : "チャット読込中",
        detail: directorySyncActive
          ? `${directorySessionSync.completedCount}/${directorySessionSync.totalCount}`
          : `${loadingCount}件取得中`,
      };
    }
    if (errorCount > 0) {
      return {
        ...base,
        status: "error",
        label: "取得失敗",
        detail: `${errorCount}件失敗`,
      };
    }
    if (staleCount > 0) {
      return {
        ...base,
        status: "stale",
        label: `未更新${staleCount}`,
        detail: `${staleCount}件が最新候補と不一致`,
      };
    }
    if (expectedAssignments.length <= 0) {
      return {
        ...base,
        status: "unknown",
        label: "同期不明",
        detail: "表示候補なし",
      };
    }
    return {
      ...base,
      status: "ok",
      label: "同期OK",
      detail: `セッション${expectedAssignments.length}件表示中`,
    };
  }, [
    directorySessionsById,
    directorySessionSync,
    panelHydrationById,
    registeredDirectories,
    registeredDirectorySessionCandidates,
  ]);

  useEffect(() => {
    logSessionDiagRef.current("mini_board_mounted", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      screen: "mini_board",
      source: MINI_BOARD_SOURCE_LABEL,
    }, { throttleMs: 0 });
    return () => {
      logSessionDiagRef.current("mini_board_unmounted", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        screen: "mini_board",
        source: MINI_BOARD_SOURCE_LABEL,
      }, { throttleMs: 0 });
      // previewパネルの全クリアは廃止(再入場時の全量再取得の原因)。
      // ポップアップだけ後始末する。
      clearPopupPanelSnapshots();
    };
  }, []);

  useEffect(() => {
    logSessionDiagRef.current("mini_board_registered_directories_ensure", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      source: MINI_BOARD_SOURCE_LABEL,
      directoryCount: registeredDirectories.length,
    }, { throttleMs: 0 });
    void ensureRegisteredDirectorySessions("screen_mount");
  }, [ensureRegisteredDirectorySessions, registeredDirectories.length]);

  useEffect(() => {
    logSessionDiagRef.current("mini_board_candidate_source_snapshot", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      ...candidateDebugSnapshot,
    }, { throttleMs: 0 });
  }, [candidateDebugSnapshot]);

  useEffect(() => {
    logSessionDiag("mini_board_chat_screen_props_prepass", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      mode: "mini_board",
      panels: MINI_BOARD_ALL_PANEL_IDS,
      source: MINI_BOARD_SOURCE_LABEL,
      candidateCount: registeredDirectorySessionCandidates.length,
      openPopupPanelId: openPopupPanelId || "",
    }, { throttleMs: 0 });
  }, [logSessionDiag, openPopupPanelId, registeredDirectorySessionCandidates.length]);

  useEffect(() => {
    let cancelled = false;
    const anyDirectoryLoading = directorySessionSync.phase === "loading";
    if (registeredDirectorySessionCandidates.length <= 0) {
      // 候補ゼロ(フィルター全解除・読込中など)でもpreviewのsnapshotは破棄しない。
      // 表示はpanelHydrationByIdのstatusで制御され、候補が戻れば
      // decidePanelHydrationの条件付き再検証で変化したパネルだけ再取得される。
      setPanelHydrationById(
        MINI_BOARD_PREVIEW_PANEL_IDS.reduce((acc, panelId) => {
          acc[panelId] = {
            status: anyDirectoryLoading ? "loading" : "error",
            sessionId: "",
            message: registeredDirectories.length <= 0
              ? "登録ディレクトリがありません"
              : anyDirectoryLoading
                ? "登録ディレクトリの履歴を取得中"
                : selectedColorFilters.length <= 0
                  ? "色を選択してください"
                  : registeredDirectorySessionCandidates.length <= 0 && allRegisteredDirectorySessionCandidates.length > 0
                    ? "この色のチャットはありません"
                    : "登録ディレクトリの履歴がありません",
          };
          return acc;
        }, {} as Record<MiniBoardPreviewPanelId, MiniBoardPanelHydrationState>)
      );
      logSessionDiagRef.current("mini_board_hydrate_skipped_no_candidates", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        source: MINI_BOARD_SOURCE_LABEL,
        registeredDirectoryCount: registeredDirectories.length,
        anyDirectoryLoading,
      }, { throttleMs: 0 });
      return () => {
        cancelled = true;
      };
    }
    // パネル単位で「割当変化 or updatedAt前進」だけをhydrate対象にする。
    // ライブ応答中や鮮度十分なsnapshotを持つパネルは再取得しない。
    const panelPlans = MINI_BOARD_PANEL_ASSIGNMENT.map((assignment) => {
      const candidate = registeredDirectorySessionCandidates[assignment.sessionIndex] || null;
      if (!candidate) return { assignment, candidate: null, snapshot: null, decision: null };
      const snapshot = getSnapshotRef.current(assignment.panelId);
      return {
        assignment,
        candidate,
        snapshot,
        decision: decidePanelHydration({
          panelId: assignment.panelId,
          candidate,
          lastRequested: lastRequestedHydrationByPanelRef.current[assignment.panelId] || null,
          snapshot,
        }),
      };
    });
    for (const plan of panelPlans) {
      if (plan.candidate) continue;
      const panelId = plan.assignment.panelId;
      delete lastRequestedHydrationByPanelRef.current[panelId];
      if (!String(getSnapshotRef.current(panelId).selectedSessionId || "").trim()) continue;
      clearPanelSnapshotRef.current(panelId);
      logSessionDiagRef.current("mini_board_hydrate_panel_insufficient_candidates", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        panelId,
        requestedSessionIndex: plan.assignment.sessionIndex,
        candidateCount: registeredDirectorySessionCandidates.length,
      }, { throttleMs: 0 });
    }
    setPanelHydrationById((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const plan of panelPlans) {
        const panelId = plan.assignment.panelId;
        const target: MiniBoardPanelHydrationState | null = !plan.candidate
          ? {
            status: "error",
            sessionId: "",
            message: `最新${plan.assignment.sessionIndex + 1}件目の履歴が不足`,
          }
          : plan.decision?.action === "hydrate"
            ? { status: "loading", sessionId: "", message: "セッション取得中" }
            // skip時のready化はhydrate完了済みsnapshot(またはライブ配信中)に限る。
            // isHydrating中にreadyへ早期遷移すると、タップ時にcopyPanelSnapshotが
            // 未完成のsnapshotをポップアップへ複製してしまう(完了時の反映はrun側)。
            : snapshotHoldsAssignedSession(plan.snapshot, plan.candidate.sessionId) &&
              !plan.snapshot?.isHydrating &&
              ((plan.snapshot?.conversationMessages.length || 0) > 0 || plan.snapshot?.isResponding)
              ? { status: "ready", sessionId: plan.candidate.sessionId, message: "" }
              // hydrate進行中(already_requested)や失敗直後は直前の表示を維持
              : null;
        if (!target) continue;
        const current = prev[panelId];
        if (
          current &&
          current.status === target.status &&
          current.sessionId === target.sessionId &&
          current.message === target.message
        ) continue;
        next[panelId] = target;
        changed = true;
      }
      return changed ? next : prev;
    });
    const hydrateTargets = panelPlans.flatMap((plan) => (
      plan.candidate && plan.decision?.action === "hydrate"
        ? [{ assignment: plan.assignment, candidate: plan.candidate }]
        : []
    ));
    if (hydrateTargets.length <= 0) {
      logSessionDiagRef.current("mini_board_hydrate_skipped_same_candidates", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        source: MINI_BOARD_SOURCE_LABEL,
        candidateCount: registeredDirectorySessionCandidates.length,
        panelDecisions: panelPlans.map((plan) => ({
          panelId: plan.assignment.panelId,
          action: plan.decision?.action || "no_candidate",
          reason: plan.decision?.reason || "",
        })),
      }, { throttleMs: 0 });
      return () => {
        cancelled = true;
      };
    }
    const run = async () => {
      const selectedByPanel: Record<string, string> = {};
      logSessionDiagRef.current("mini_board_hydrate_sessions_start", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        source: MINI_BOARD_SOURCE_LABEL,
        panelDecisions: panelPlans.map((plan) => ({
          panelId: plan.assignment.panelId,
          action: plan.decision?.action || "no_candidate",
          reason: plan.decision?.reason || "",
        })),
        candidates: hydrateTargets.slice(0, 8).map(({ candidate }) => ({
          sessionId: candidate.sessionId,
          directory: candidate.directory,
          directoryDisplayName: candidate.directoryDisplayName,
          cwd: candidate.cwd,
          updatedAt: candidate.updatedAt,
          contextUsedPct: candidate.contextUsedPct,
          modelRef: candidate.modelRef,
          reasoningEffort: candidate.reasoningEffort,
        })),
      }, { throttleMs: 0 });
      for (const { assignment, candidate } of hydrateTargets) {
        const panelId = assignment.panelId;
        logSessionDiagRef.current("mini_board_hydrate_candidate_request", {
          miniBoardCycleId: miniBoardCycleIdRef.current,
          panelId,
          requestedSessionId: candidate.sessionId,
          requestedDirectory: candidate.directory,
          requestedDirectoryDisplayName: candidate.directoryDisplayName,
          requestedCwd: candidate.cwd,
          requestedTitle: candidate.firstUserMessage,
          requestedContextUsedPct: candidate.contextUsedPct,
          requestedModelRef: candidate.modelRef,
          requestedReasoningEffort: candidate.reasoningEffort,
        }, { throttleMs: 0 });
        // 発行記録は失敗時も残し、同じupdatedAtのままでのホットリトライを防ぐ
        // (updatedAtが前進すれば再試行される)。
        const requestMark = buildPanelHydrationRequestMark(panelId, candidate);
        lastRequestedHydrationByPanelRef.current[panelId] = requestMark;
        const hydrationResult = await hydratePanelFromSessionHistoryRef.current({
          panelId,
          sessionId: candidate.sessionId,
          directory: candidate.directory,
          directoryDisplayName: candidate.directoryDisplayName,
          diagnosticCycleId: miniBoardCycleIdRef.current,
          title: candidate.firstUserMessage,
          updatedAt: candidate.updatedAt,
          modelRef: candidate.modelRef,
          reasoningEffort: candidate.reasoningEffort,
          contextUsedPct: candidate.contextUsedPct,
        });
        if (hydrationResult === "superseded") return;
        // この要求がまだ最新(後続runが再要求していない)なら、effectがキャンセル済み
        // でも結果を反映する。後続runはalready_requestedでこのパネルをスキップして
        // loading表示を維持しているため、ここで反映しないとスケルトンが固着する。
        const stillCurrentRequest =
          lastRequestedHydrationByPanelRef.current[panelId] === requestMark;
        if (stillCurrentRequest) {
          const ok = hydrationResult === "applied";
          logSessionDiagRef.current("mini_board_hydrate_candidate_result", {
            miniBoardCycleId: miniBoardCycleIdRef.current,
            panelId,
            requestedSessionId: candidate.sessionId,
            ok,
          }, { throttleMs: 0 });
          if (ok) {
            selectedByPanel[panelId] = candidate.sessionId;
          } else {
            clearPanelSnapshotRef.current(panelId);
          }
          setPanelHydrationById((prev) => ({
            ...prev,
            [panelId]: ok
              ? { status: "ready", sessionId: candidate.sessionId, message: "" }
              : { status: "error", sessionId: candidate.sessionId, message: "セッション読み込み失敗" },
          }));
        }
        if (cancelled) return;
      }
      logSessionDiagRef.current("mini_board_hydrate_sessions_done", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        selectedByPanel,
      }, { throttleMs: 0 });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    allRegisteredDirectorySessionCandidates.length,
    directorySessionsById,
    registeredDirectories,
    directorySessionSync.phase,
    registeredDirectorySessionCandidates,
    selectedColorFilters.length,
  ]);

  const openPopupWithSource = (
    assignment: typeof MINI_BOARD_PANEL_ASSIGNMENT[number],
    sourceRect: PopupChatSourceRect | null
  ) => {
    logSessionDiag("mini_board_popup_open", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      previewPanelId: assignment.panelId,
      popupPanelId: assignment.popupPanelId,
    }, { throttleMs: 0 });
    const candidate = registeredDirectorySessionCandidates[assignment.sessionIndex];
    if (!candidate) {
      showChatBottomToast("assistant", "このミニチャットは未取得またはエラーです");
      return;
    }
    markSessionRead(candidate.sessionId, candidate.source, candidate.directory);
    const hydrationState = panelHydrationById[assignment.panelId];
    if (hydrationState?.status === "ready") {
      copyPanelSnapshot(assignment.panelId, assignment.popupPanelId);
    } else {
      void hydratePanelFromSessionHistoryRef.current({
        panelId: assignment.popupPanelId,
        sessionId: candidate.sessionId,
        directory: candidate.directory,
        directoryDisplayName: candidate.directoryDisplayName,
        diagnosticCycleId: miniBoardCycleIdRef.current,
        title: candidate.firstUserMessage,
        updatedAt: candidate.updatedAt,
        modelRef: candidate.modelRef,
        reasoningEffort: candidate.reasoningEffort,
        contextUsedPct: candidate.contextUsedPct,
      }).then((result) => {
        if (result === "applied" || result === "superseded") return;
        showChatBottomToast("assistant", "セッションをポップアップに読み込めませんでした。");
        clearPanelSnapshotRef.current(assignment.popupPanelId);
        if (openPopupPanelIdRef.current === assignment.popupPanelId) {
          setPopupSourceRect(null);
          setHiddenPopupSourcePanelId(null);
          setOpenPopupPanelId(null);
        }
      }).catch((err) => {
        showChatBottomToast("assistant", `セッション読込に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        clearPanelSnapshotRef.current(assignment.popupPanelId);
        if (openPopupPanelIdRef.current === assignment.popupPanelId) {
          setPopupSourceRect(null);
          setHiddenPopupSourcePanelId(null);
          setOpenPopupPanelId(null);
        }
      });
    }
    setPopupSourceRect(sourceRect);
    setHiddenPopupSourcePanelId(assignment.panelId);
    openPopupPanelIdRef.current = assignment.popupPanelId;
    setOpenPopupPanelId(assignment.popupPanelId);
  };

  const openPopup = (assignment: typeof MINI_BOARD_PANEL_ASSIGNMENT[number]) => {
    const candidate = registeredDirectorySessionCandidates[assignment.sessionIndex];
    if (!candidate) {
      showChatBottomToast("assistant", "このミニチャットは未取得またはエラーです");
      logSessionDiag("mini_board_popup_open_blocked_unready", {
        miniBoardCycleId: miniBoardCycleIdRef.current,
        previewPanelId: assignment.panelId,
        popupPanelId: assignment.popupPanelId,
        status: panelHydrationById[assignment.panelId]?.status || "unknown",
        message: panelHydrationById[assignment.panelId]?.message || "",
      }, { throttleMs: 0 });
      return;
    }
    const previewCard = previewCardRefs.current[assignment.panelId];
    if (!previewCard?.measureInWindow) {
      openPopupWithSource(assignment, null);
      return;
    }
    previewCard.measureInWindow((x, y, width, height) => {
      openPopupWithSource(assignment, { x, y, width, height });
    });
  };

  const closePopup = () => {
    logSessionDiag("mini_board_popup_close", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      panelId: openPopupPanelId || undefined,
    }, { throttleMs: 0 });
    if (openPopupPanelId) {
      clearPanelSnapshot(openPopupPanelId);
    }
    openPopupPanelIdRef.current = null;
    setPopupSourceRect(null);
    setHiddenPopupSourcePanelId(null);
    setOpenPopupPanelId(null);
  };

  const toggleColorFilter = (nextColorFilter: DirectoryMarkerColor) => {
    setSelectedColorFilters((prev) => (
      prev.includes(nextColorFilter)
        ? prev.filter((item) => item !== nextColorFilter)
        : [...prev, nextColorFilter]
    ));
  };

  const openColorFilterPicker = () => {
    colorFilterPickerAnimationIdRef.current += 1;
    colorFilterPickerAnimRef.current.stopAnimation();
    colorFilterPickerAnimRef.current.setValue(0);
    setColorFilterPickerRendered(true);
    setColorFilterPickerOpen(true);
    Animated.timing(colorFilterPickerAnimRef.current, {
      toValue: 1,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const closeColorFilterPicker = () => {
    const animationId = colorFilterPickerAnimationIdRef.current + 1;
    colorFilterPickerAnimationIdRef.current = animationId;
    colorFilterPickerAnimRef.current.stopAnimation();
    setColorFilterPickerOpen(false);
    Animated.timing(colorFilterPickerAnimRef.current, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || colorFilterPickerAnimationIdRef.current !== animationId) return;
      setColorFilterPickerRendered(false);
    });
  };

  const handleLoadMore = () => {
    logSessionDiag("mini_board_load_more_press", {
      miniBoardCycleId: miniBoardCycleIdRef.current,
      source: MINI_BOARD_SOURCE_LABEL,
      visiblePanelCount: MINI_BOARD_PREVIEW_PANEL_IDS.length,
      candidateCount: registeredDirectorySessionCandidates.length,
    }, { throttleMs: 0 });
    void refreshRegisteredDirectorySessions("manual_refresh");
    showChatBottomToast("assistant", "さらに読み込み: 登録ディレクトリの履歴を更新しました");
  };

  return (
    <View style={miniBoardStyles.root}>
      <View style={[styles.debugHeaderRow, miniBoardStyles.topRow]}>
        <TouchableOpacity
          style={[styles.debugBackButton, miniBoardStyles.menuButton]}
          onPress={() => {
            setOpenPopupPanelId(null);
            clearPopupPanelSnapshots();
            openDrawer();
          }}
          accessibilityRole="button"
          accessibilityLabel="メニューを開く"
        >
          <Text style={[styles.debugBackButtonText, miniBoardStyles.menuButtonText]}>☰</Text>
        </TouchableOpacity>
        {!colorFilterPickerRendered ? (
          <TouchableOpacity
            style={miniBoardStyles.filterTrigger}
            onPress={openColorFilterPicker}
            accessibilityRole="button"
            accessibilityLabel="ドット色フィルターを開く"
          >
            <View style={miniBoardStyles.filterTriggerDotStack}>
              {filterTriggerDots.map((option, dotIndex) => (
                <View
                  key={`${option.value}-${dotIndex}`}
                  style={[
                    miniBoardStyles.filterTriggerDot,
                    miniBoardStyles[`filterTriggerDot${dotIndex}` as "filterTriggerDot0" | "filterTriggerDot1" | "filterTriggerDot2"],
                    { backgroundColor: option.color },
                    option.value === "none" ? miniBoardStyles.markerDotNone : null,
                  ]}
                />
              ))}
            </View>
          </TouchableOpacity>
        ) : null}
        {colorFilterPickerRendered ? (
          <Animated.View style={[miniBoardStyles.filterInlinePicker, colorFilterPickerAnimatedStyle]}>
            {MINI_BOARD_MARKER_OPTIONS.map((option) => {
              const selected = selectedColorFilters.includes(option.value);
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[miniBoardStyles.filterChip, selected ? miniBoardStyles.filterChipSelected : null]}
                  onPress={() => toggleColorFilter(option.value)}
                  accessibilityRole="button"
                  accessibilityLabel={`ドット色フィルター ${option.label} ${selected ? "選択中" : "未選択"}`}
                >
                  <View
                    style={[
                      miniBoardStyles.filterDot,
                      { backgroundColor: option.color },
                      option.value === "none" ? miniBoardStyles.markerDotNone : null,
                    ]}
                  />
                  {selected ? <View style={miniBoardStyles.filterSelectedMark} /> : null}
                </TouchableOpacity>
              );
            })}
          </Animated.View>
        ) : null}
      </View>
      {colorFilterPickerRendered ? (
        <Pressable
          pointerEvents={colorFilterPickerOpen ? "auto" : "none"}
          style={miniBoardStyles.filterDismissLayer}
          onPress={closeColorFilterPicker}
        />
      ) : null}
      <View style={miniBoardStyles.content}>
        <ScrollView
          style={miniBoardStyles.previewScroll}
          contentContainerStyle={miniBoardStyles.previewGrid}
          showsVerticalScrollIndicator={false}
        >
          {panelRows.map((row, rowIndex) => (
            <View
              key={`mini-board-row-${rowIndex}`}
              style={[miniBoardStyles.previewRow, { height: previewCardHeight }]}
            >
              {row.map((assignment) => {
                const index = assignment.sessionIndex;
                const candidate = registeredDirectorySessionCandidates[index];
                const hydrationState = panelHydrationById[assignment.panelId];
                const isReady = hydrationState?.status === "ready";
                const isLoading = (!candidate && directorySessionSync.phase === "loading") || hydrationState?.status === "loading";
                const canOpenPopup = !!candidate && !isLoading;
                return (
                  <View
                    key={assignment.panelId}
                    ref={(node) => {
                      previewCardRefs.current[assignment.panelId] = node;
                    }}
                    style={[
                      miniBoardStyles.chatPreviewCard,
                      hiddenPopupSourcePanelId === assignment.panelId ? miniBoardStyles.chatPreviewCardHidden : null,
                    ]}
                  >
                    {isLoading ? (
                      <MiniBoardChatPreviewSkeleton />
                    ) : isReady ? (
                      <View pointerEvents="none" style={miniBoardStyles.chatPreviewInner}>
                        <ChatScreen
                          mode="mini_board"
                          panelId={assignment.panelId}
                          miniBoardCycleId={miniBoardCycleIdRef.current}
                        />
                      </View>
                    ) : (
                      <View style={miniBoardStyles.chatPreviewError}>
                        <Text style={miniBoardStyles.chatPreviewErrorTitle}>セッション未表示</Text>
                        <Text style={miniBoardStyles.chatPreviewErrorText}>
                          {hydrationState?.message || "取得待ち"}
                        </Text>
                      </View>
                    )}
                    {canOpenPopup ? (
                      <TouchableOpacity
                        style={miniBoardStyles.chatPreviewTapLayer}
                        onPress={() => openPopup(assignment)}
                        accessibilityRole="button"
                        accessibilityLabel={`ミニチャット${index + 1}を開く`}
                      />
                    ) : null}
                  </View>
                );
              })}
              {row.length > 1 ? (
                <View pointerEvents="none" style={miniBoardStyles.previewVerticalSeparator} />
              ) : null}
              {rowIndex < panelRows.length - 1 ? (
                <View pointerEvents="none" style={miniBoardStyles.previewHorizontalSeparator} />
              ) : null}
            </View>
          ))}
          <TouchableOpacity
            style={miniBoardStyles.loadMoreButton}
            onPress={handleLoadMore}
            accessibilityRole="button"
            accessibilityLabel="さらに読み込む"
          >
            <Text style={miniBoardStyles.loadMoreButtonText}>さらに読み込む</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
      {!openPopupPanelId ? (
        <View pointerEvents="box-none" style={miniBoardStyles.floatingControls}>
          <RunnerWsConnectionStatus
            dataSync={miniBoardDataSync}
            selectedRoute={runnerRouteSelection.selectedRoute}
          />
          <View style={miniBoardStyles.statusMenu}>
            <CodexStatusSummaryMenu
              statusText={codexCliStatusText}
              statusFetchedAtMs={codexCliStatusFetchedAtMs}
              statusLoading={codexCliStatusLoading}
              authProfileId={codexAuthProfileId}
              authProfiles={codexAuthProfiles}
              authProfilesLoading={codexAuthProfilesLoading}
              authSwitching={codexAuthSwitching}
              authSwitchError={codexAuthSwitchError}
              onRefreshStatus={refreshCodexCliStatus}
              onLoadAuthProfiles={loadCodexAuthProfiles}
              onSwitchAuthProfile={switchCodexAuthProfile}
            />
          </View>
        </View>
      ) : null}
      {openPopupPanelId ? (
        <View pointerEvents="box-none" style={miniBoardStyles.popupOverlayHost}>
          <PopupChatOverlay
            visible={!!openPopupPanelId}
            panelId={openPopupPanelId || ""}
            cycleId={miniBoardCycleIdRef.current}
            sourceRect={popupSourceRect}
            onClose={closePopup}
          />
        </View>
      ) : null}
    </View>
  );
}
