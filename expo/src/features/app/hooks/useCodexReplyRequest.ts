import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  deriveCodexSessionStateFromSnapshot,
  enqueueRunnerCodexTurn,
  isCodexAppServerTurnInterruptedError,
  startCodexAppServerTurn,
  type CodexAppServerTurnResult,
  type CodexAppServerTurnSession,
} from "../../codex/codexAppServerClient";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { normalizeModelRef, type CodexApprovalPolicy, type ReasoningEffort } from "../utils/settingsParsers";
import type { LlmUiStatus } from "./useLlmRequestStatus";
import type { LlmMessageCompletion, TtsPlaybackTarget } from "../types/appTypes";
import type {
  ConversationRuntimeRequestLifecycle,
  ConversationRuntimeRequestSnapshotInput,
} from "./useConversationRuntimeStoreController";

type ConversationMessageLike = {
  id: string;
  role: "user" | "assistant";
  content: string;
  codexQueue?: {
    queuedTurnId: string;
    status: "queued" | "waiting_compact" | "running" | "completed" | "failed" | "cancelled";
    errorMessage?: string;
  };
};

type PanelConversationWriteOptions = {
  contextUsedPct?: number | null;
  isResponding?: boolean;
  selectedThreadStatusType?: string;
  sessionId?: string;
  adoptFromSessionId?: string;
  clearRespondingRequestStartedAtMs?: number | null;
};

type SttMessageMetaLike = {
  source: "recording_uri" | "native_direct";
};

type SessionDiagLogOptions = {
  detailed?: boolean;
  throttleMs?: number;
  throttleKey?: string;
};

type UseCodexReplyRequestOptions<
  TMessage extends ConversationMessageLike,
  TSttMeta extends SttMessageMetaLike,
  THistoryEntry,
> = {
  transcript: string;
  codexWsUrl: string;
  codexWsToken: string;
  runnerWebSocketManager?: RunnerWebSocketManager;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  codexApprovalPolicy: CodexApprovalPolicy;
  autoSpeakAfterReply: boolean;
  isChatOpenForAutoSpeech?: (target: TtsPlaybackTarget) => boolean;
  conversationMessagesRef: MutableRefObject<TMessage[]>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamAudioWaveformBarsRef: MutableRefObject<number[][]>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  llmRequestStartedAtRef: MutableRefObject<number>;
  setTranscript: (value: string) => void;
  setReply: (value: string) => void;
  setReplyLoadingWithRef: (loading: boolean) => void;
  setError: (value: string) => void;
  setReplyDebug: (value: string | ((prev: string) => string)) => void;
  setStreamMode: (value: string) => void;
  setStreamLlmNativeDeltaCount: (value: number) => void;
  setStreamLlmPseudoDeltaCount: (value: number | ((prev: number) => number)) => void;
  setStreamFirstNativeDeltaOffsetMs: (value: number | null) => void;
  resetStreamLlmDeltas: () => void;
  resetStreamLlmProgress: () => void;
  resetStreamSegments: () => void;
  setStreamWaveformPreview: (value: number[]) => void;
  setTtsPlaybackMessageIdWithRef: (value: string) => void;
  setStreamReplyYouTubeVideoIdsWithRef: (ids: string[]) => void;
  clearStreamAudioQueue: () => void;
  runSlashCommand: (
    text: string,
    options: {
      clearInput: boolean;
      sttMeta?: TSttMeta;
      panelId?: string;
      sessionSnapshot?: ReplyRequestSessionSnapshot;
    }
  ) => Promise<boolean>;
  prepareChatForOutgoingMessageWindow: () => void;
  setConversationMessagesWithLimit: (messages: TMessage[]) => TMessage[];
  buildConversationMessage: (
    role: "user" | "assistant",
    content: string,
    extra?: Record<string, unknown>
  ) => TMessage;
  setHistory: (updater: (prev: THistoryEntry[]) => THistoryEntry[]) => void;
  createHistoryEntry: (params: { transcript: string; reply: string }) => THistoryEntry;
  getPanelConversationMessages?: (panelId: string) => TMessage[];
  setPanelConversationMessages?: (
    panelId: string,
    messages: TMessage[],
    options?: PanelConversationWriteOptions
  ) => void;
  normalizedLlmDirectoryForRequest: () => string;
  isCodexCompactRunning?: (threadId: string) => boolean;
  syncLlmConversationSessionId: (
    value: unknown,
    options?: { expectedCurrentSessionId?: unknown; syncSelected?: boolean }
  ) => boolean;
  rememberKnownCodexThreadId?: (value: unknown) => void;
  handleApprovalRequest: (request: ApprovalRequest) => Promise<ApprovalAction> | ApprovalAction;
  onApprovalRequestResolved?: (request: ApprovalRequest) => void;
  setSelectedThreadStatusType: (statusType: string) => void;
  appendLlmDelta: (source: "native", delta: string) => void;
  applyAssistantReply: (raw: string) => string;
  updateLlmStatus: (status: LlmUiStatus, detail?: string) => void;
  startLlmRequest: (status: LlmUiStatus, detail?: string) => void;
  finishLlmRequest: (status: LlmUiStatus, detail?: string) => void;
  parseContextUsageUsedPct: (raw: unknown) => number | null;
  fetchRunnerSessionContextUsedPct: (sessionId: string, directory: string) => Promise<number | null>;
  extractYouTubeVideoIds: (text: string) => string[];
  stripYouTubeTags: (text: string) => string;
  fetchYouTubeVideoMetadata: (videoIds: string[]) => Promise<void>;
  synthesizeSpeechStream: (textOverride?: string, options?: TtsPlaybackTarget) => Promise<void>;
  playUiSfx: (key: "send" | "reply") => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: SessionDiagLogOptions
  ) => void;
  uploadCodexWsPreflightLog: (params: {
    phase: string;
    targetWsUrl: string;
    targetWsToken: string;
    extra?: Record<string, unknown>;
  }) => Promise<string>;
  trimForInline: (value: string, maxChars: number) => string;
  reportError: (raw: unknown, scope?: string) => void;
  updateConversationRuntimeRequest?: (input: ConversationRuntimeRequestSnapshotInput) => void;
  onLlmMessageCompleted?: (completion: LlmMessageCompletion) => void | Promise<void>;
  startCodexRelayObserverForSession?: (
    threadIdRaw: unknown,
    options?: {
      directory?: string;
      startedAtMs?: number | null;
      resumeFromSeq?: number;
      reason?: string;
      panelId?: string;
    }
  ) => boolean;
};

type ReplyRequestSessionSnapshot = {
  sessionId?: string;
  threadId?: string;
  directory?: string;
  directoryDisplayName?: string;
  sessionTitle?: string;
  modelRef?: string;
  reasoningEffort?: ReasoningEffort | string;
  source?: string;
};

type ReplyRequestOptions<TSttMeta> = {
  sttMeta?: TSttMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
};

type InFlightCodexTurnRequest = {
  requestId: string;
  requestSeq: number;
  panelId: string;
  session: CodexAppServerTurnSession;
  threadId: string;
  startedAt: number;
};

type InFlightThreadState = {
  requestId: string;
  requestSeq: number;
  panelId: string;
  startedAt: number;
  status: LlmUiStatus;
  statusDetail: string;
  replyBuffer: string;
};

type PanelRequestState = {
  activeRequestSeq: number;
  activeRequestThreadId: string;
  activeRequestSeqByThreadId: Record<string, number>;
  cancelledRequestSeq: number | null;
  cancelledRequestSeqByThreadId: Record<string, number | null>;
  inFlightTurnRequest: InFlightCodexTurnRequest | null;
  inFlightTurnRequestByThreadId: Record<string, InFlightCodexTurnRequest>;
};

const LEGACY_MAIN_PANEL_ID = "main";

function normalizePanelId(panelIdRaw: unknown): string {
  const panelId = String(panelIdRaw || "").trim();
  if (!panelId || panelId === LEGACY_MAIN_PANEL_ID) return "";
  return panelId;
}

function createInitialPanelRequestState(): PanelRequestState {
  return {
    activeRequestSeq: 0,
    activeRequestThreadId: "",
    activeRequestSeqByThreadId: {},
    cancelledRequestSeq: null,
    cancelledRequestSeqByThreadId: {},
    inFlightTurnRequest: null,
    inFlightTurnRequestByThreadId: {},
  };
}

function isThreadResumeRpcTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("Codex app-server RPC timeout") &&
    message.includes("thread/resume")
  );
}

function createReplyTraceId(requestSeq: number): string {
  const nowPart = Date.now().toString(36);
  const seqPart = Math.max(0, Math.floor(Number(requestSeq) || 0)).toString(36);
  const randPart = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, "0");
  return `reply-${nowPart}-${seqPart}-${randPart}`;
}

function normalizeReasoningEffort(raw: unknown, fallback: ReasoningEffort): ReasoningEffort {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return fallback;
}

export function useCodexReplyRequest<
  TMessage extends ConversationMessageLike,
  TSttMeta extends SttMessageMetaLike,
  THistoryEntry,
>(options: UseCodexReplyRequestOptions<TMessage, TSttMeta, THistoryEntry>) {
  const optionsRef = useRef(options);
  const nextRequestSeqRef = useRef(0);
  const panelRequestStateByIdRef = useRef<Record<string, PanelRequestState>>({});
  const inFlightByThreadRef = useRef<Record<string, InFlightThreadState>>({});

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const getPanelRequestState = useCallback((panelIdRaw: unknown, create = false) => {
    const panelId = normalizePanelId(panelIdRaw);
    const existing = panelRequestStateByIdRef.current[panelId];
    if (existing) return existing;
    if (!create) return null;
    const next = createInitialPanelRequestState();
    panelRequestStateByIdRef.current[panelId] = next;
    return next;
  }, []);

  const resolveRequestControlTarget = useCallback((panelIdRaw: unknown, threadIdRaw?: unknown) => {
    const targetPanelId = normalizePanelId(panelIdRaw);
    const targetThreadId = String(threadIdRaw || "").trim();
    const panelState = getPanelRequestState(targetPanelId);
    const inFlight = (
      targetThreadId
        ? panelState?.inFlightTurnRequestByThreadId[targetThreadId]
        : null
    ) || panelState?.inFlightTurnRequest || null;
    const panelActiveRequestSeq = (
      targetThreadId
        ? (panelState?.activeRequestSeqByThreadId[targetThreadId] || 0)
        : (panelState?.activeRequestSeq || 0)
    );
    const requestSeq = inFlight?.requestSeq || panelActiveRequestSeq;
    const globalInFlightOwnerPanelId = Object.values(inFlightByThreadRef.current)
      .find((state) => Number(state?.requestSeq) === requestSeq)?.panelId;
    const ownerPanelId = String(
      inFlight?.panelId ||
      globalInFlightOwnerPanelId ||
      (panelActiveRequestSeq > 0 ? targetPanelId : "")
    ).trim();
    return {
      panelState,
      inFlight,
      requestSeq,
      ownerPanelId: normalizePanelId(ownerPanelId),
      sessionId: String(inFlight?.threadId || targetThreadId || "").trim(),
    };
  }, [getPanelRequestState]);

  const clearPanelRequestTracking = useCallback((panelIdRaw: unknown, requestSeqRaw: unknown, threadIdRaw?: unknown) => {
    const requestSeq = Number(requestSeqRaw);
    const threadId = String(threadIdRaw || "").trim();
    const panelState = getPanelRequestState(panelIdRaw);
    const result = {
      clearedPanelActive: false,
      clearedThreadActive: false,
      clearedPanelInFlight: false,
      clearedThreadInFlight: false,
    };
    if (!panelState || !Number.isFinite(requestSeq) || requestSeq <= 0) return result;
    const threadIdsToClear = new Set<string>();
    if (threadId) threadIdsToClear.add(threadId);
    if (panelState.activeRequestSeq === requestSeq) {
      const activeThreadId = String(panelState.activeRequestThreadId || "").trim();
      if (activeThreadId) threadIdsToClear.add(activeThreadId);
    }
    for (const [candidateThreadId, activeRequestSeq] of Object.entries(panelState.activeRequestSeqByThreadId)) {
      if (activeRequestSeq === requestSeq) threadIdsToClear.add(candidateThreadId);
    }
    for (const [candidateThreadId, inFlightRequest] of Object.entries(panelState.inFlightTurnRequestByThreadId)) {
      if (inFlightRequest?.requestSeq === requestSeq) threadIdsToClear.add(candidateThreadId);
    }
    if (panelState.inFlightTurnRequest?.requestSeq === requestSeq) {
      panelState.inFlightTurnRequest = null;
      result.clearedPanelInFlight = true;
    }
    for (const candidateThreadId of threadIdsToClear) {
      if (panelState.inFlightTurnRequestByThreadId[candidateThreadId]?.requestSeq === requestSeq) {
        delete panelState.inFlightTurnRequestByThreadId[candidateThreadId];
        result.clearedThreadInFlight = true;
      }
    }
    if (panelState.activeRequestSeq === requestSeq) {
      panelState.activeRequestSeq = 0;
      panelState.activeRequestThreadId = "";
      panelState.cancelledRequestSeq = null;
      result.clearedPanelActive = true;
    }
    for (const candidateThreadId of threadIdsToClear) {
      if (panelState.activeRequestSeqByThreadId[candidateThreadId] === requestSeq) {
        delete panelState.activeRequestSeqByThreadId[candidateThreadId];
        delete panelState.cancelledRequestSeqByThreadId[candidateThreadId];
        result.clearedThreadActive = true;
      }
    }
    return result;
  }, [getPanelRequestState]);

  const sendReplyRequest = useCallback(async (
    transcriptOverride?: string,
    requestOptions?: ReplyRequestOptions<TSttMeta>
  ) => {
    const current = optionsRef.current;
    const requestPanelId = normalizePanelId(requestOptions?.panelId);
    const panelRequestState = getPanelRequestState(requestPanelId, true)!;
    const effectiveTranscript = (transcriptOverride ?? current.transcript).trim();
    const targetCodexWsUrl = current.codexWsUrl.trim();
    const clearInput = typeof transcriptOverride === "undefined";
    const requestSnapshot = requestOptions?.sessionSnapshot;
    const requestUiSessionId = String(requestSnapshot?.sessionId || "").trim();
    const requestThreadId = String(
      requestSnapshot?.threadId || ""
    ).trim();
    const requestDirectory = String(
      requestSnapshot?.directory || current.normalizedLlmDirectoryForRequest() || ""
    ).trim();
    const requestSnapshotSource = String(requestSnapshot?.source || "").trim();
    let requestThreadKey = requestThreadId || requestUiSessionId;
    const requestSessionAdoptionSourceId = requestThreadKey || requestUiSessionId;
    const requestModelRef = normalizeModelRef(requestSnapshot?.modelRef || current.modelRef);
    const requestReasoningEffort = normalizeReasoningEffort(
      requestSnapshot?.reasoningEffort,
      current.reasoningEffort
    );
    const compactRunningLocally = Boolean(
      requestThreadKey && current.isCodexCompactRunning?.(requestThreadKey)
    );
    const readPanelMessages = (): TMessage[] => {
      if (typeof current.getPanelConversationMessages === "function") {
        const panelMessages = current.getPanelConversationMessages(requestPanelId);
        if (Array.isArray(panelMessages)) return panelMessages;
      }
      return [];
    };
    const writePanelMessages = (
      messages: TMessage[],
      options?: PanelConversationWriteOptions
    ) => {
      if (typeof current.setPanelConversationMessages === "function") {
        current.setPanelConversationMessages(requestPanelId, messages, options);
        return;
      }
    };
    const findRecentMatchingUserMessageIndex = (messages: TMessage[]) => {
      const index = messages.length - 1;
      if (index < 0) return -1;
      const nowMs = Date.now();
      const candidate = messages[index] as TMessage & { at?: string };
      if (String(candidate.role || "") !== "user") return -1;
      if (String(candidate.content || "").trim() !== effectiveTranscript) return -1;
      const queuedTurnId = String((candidate as any)?.codexQueue?.queuedTurnId || "").trim();
      if (queuedTurnId) return -1;
      const atMs = Date.parse(String(candidate.at || ""));
      if (Number.isFinite(atMs) && nowMs - atMs > 15000) return -1;
      return index;
    };

    if (await current.runSlashCommand(effectiveTranscript, {
      clearInput,
      sttMeta: requestOptions?.sttMeta,
      panelId: requestPanelId,
      sessionSnapshot: requestOptions?.sessionSnapshot,
    })) {
      current.logSessionDiag("reply_http_send_skipped", {
        reason: "slash_command",
        panelId: requestPanelId,
        sessionId: String(requestOptions?.sessionSnapshot?.sessionId || "").trim() || undefined,
        directory: String(requestOptions?.sessionSnapshot?.directory || "").trim() || undefined,
        transcriptChars: effectiveTranscript.length,
      }, { throttleMs: 0 });
      return;
    }
    if (
      effectiveTranscript &&
      requestThreadKey &&
      targetCodexWsUrl
    ) {
      try {
        const queued = await enqueueRunnerCodexTurn({
          wsUrl: targetCodexWsUrl,
          wsToken: current.codexWsToken.trim(),
          threadId: requestThreadKey,
          inputText: effectiveTranscript,
          cwd: requestDirectory || undefined,
          model: requestModelRef || undefined,
          effort: requestReasoningEffort || undefined,
          approvalPolicy: current.codexApprovalPolicy,
          sourcePanelId: requestPanelId,
          clientRequestId: `compact-queue-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          onlyIfCompacting: true,
          waitForCompactMs: compactRunningLocally ? 15000 : undefined,
        });
        if (queued.queued && queued.queuedTurn) {
          if (clearInput) current.setTranscript("");
          const currentMessages = readPanelMessages();
          const queuePatch = {
            codexQueue: {
              queuedTurnId: queued.queuedTurn.queuedTurnId,
              status: queued.queuedTurn.status,
              errorMessage: queued.queuedTurn.errorMessage || undefined,
            },
          };
          const matchedUserIndex = findRecentMatchingUserMessageIndex(currentMessages);
          const queuedMessages = matchedUserIndex >= 0
            ? currentMessages.map((message, index) => (
              index === matchedUserIndex
                ? ({
                  ...message,
                  ...queuePatch,
                })
                : message
            ))
            : [
              ...currentMessages,
              current.buildConversationMessage(
                "user",
                effectiveTranscript,
                {
                  ...(requestOptions?.sttMeta ? { sttMeta: requestOptions.sttMeta } : {}),
                  ...queuePatch,
                } as Omit<Partial<TMessage>, "id" | "role" | "content">
              ),
            ];
          writePanelMessages(queuedMessages, {
            isResponding: false,
            selectedThreadStatusType: "active",
            sessionId: requestThreadKey,
          });
          current.startCodexRelayObserverForSession?.(requestThreadKey, {
            directory: requestDirectory || undefined,
            startedAtMs: Date.now(),
            resumeFromSeq: 0,
            reason: "codex_queue_turn",
            panelId: requestPanelId,
          });
          current.logSessionDiag("reply_http_send_queued_after_compact", {
            panelId: requestPanelId,
            threadId: requestThreadKey,
            queuedTurnId: queued.queuedTurn.queuedTurnId,
            modelRef: requestModelRef,
            reasoningEffort: requestReasoningEffort,
            compactRunningLocally,
          }, { throttleMs: 0 });
          return;
        }
        current.logSessionDiag("reply_http_send_queue_not_compacting", {
          panelId: requestPanelId,
          threadId: requestThreadKey,
          reason: queued.reason || "not_compacting",
          modelRef: requestModelRef,
          reasoningEffort: requestReasoningEffort,
          compactRunningLocally,
        }, { throttleMs: 0 });
      } catch (error) {
        current.logSessionDiag("reply_http_compact_queue_failed", {
          panelId: requestPanelId,
          threadId: requestThreadKey,
          message: error instanceof Error ? error.message : String(error),
        }, { throttleMs: 0 });
      }
    }
    const activeRequestSeqForThread = requestThreadKey
      ? (panelRequestState.activeRequestSeqByThreadId[requestThreadKey] || 0)
      : 0;
    const shouldBlockForActiveRequest = requestThreadKey
      ? activeRequestSeqForThread > 0
      : panelRequestState.activeRequestSeq > 0;
    if (!effectiveTranscript || shouldBlockForActiveRequest) {
      current.logSessionDiag("reply_http_send_skipped", {
        reason: !effectiveTranscript
          ? "empty_transcript"
          : (requestThreadKey ? "thread_reply_loading" : "panel_reply_loading"),
        panelId: requestPanelId,
        requestThreadId: requestThreadId || undefined,
        requestUiSessionId: requestUiSessionId || undefined,
        requestThreadKey: requestThreadKey || undefined,
        transcriptChars: effectiveTranscript.length,
        panelActiveRequestSeq: panelRequestState.activeRequestSeq,
        threadActiveRequestSeq: activeRequestSeqForThread,
      }, { throttleMs: 0 });
      return;
    }
    if (!targetCodexWsUrl) {
      current.logSessionDiag("reply_http_send_skipped", {
        reason: "missing_codex_ws_url",
        transcriptChars: effectiveTranscript.length,
      }, { throttleMs: 0 });
      return;
    }
    const requestSeq = nextRequestSeqRef.current + 1;
    nextRequestSeqRef.current = requestSeq;
    panelRequestState.activeRequestSeq = requestSeq;
    panelRequestState.activeRequestThreadId = requestThreadKey;
    if (requestThreadKey) {
      panelRequestState.activeRequestSeqByThreadId[requestThreadKey] = requestSeq;
      delete panelRequestState.cancelledRequestSeqByThreadId[requestThreadKey];
    }
    panelRequestState.cancelledRequestSeq = null;
    const requestTraceId = createReplyTraceId(requestSeq);
    current.logSessionDiag("reply_http_panel_request_state_begin", {
      requestTraceId,
      requestSeq,
      requestPanelId,
      requestUiSessionId: requestUiSessionId || undefined,
      requestThreadId: requestThreadId || undefined,
      requestThreadKey: requestThreadKey || undefined,
      activeRequestSeq: panelRequestState.activeRequestSeq,
      activeRequestThreadId: panelRequestState.activeRequestThreadId || undefined,
      activeThreadKeys: Object.keys(panelRequestState.activeRequestSeqByThreadId),
      cancelledRequestSeq: panelRequestState.cancelledRequestSeq,
      inFlightThreadKeys: Object.keys(panelRequestState.inFlightTurnRequestByThreadId),
      hasInFlightTurnRequest: !!panelRequestState.inFlightTurnRequest,
    }, { throttleMs: 0 });
    const getConversationMessagesForPanel = (panelId: string): TMessage[] => {
      const normalizedPanelId = normalizePanelId(panelId);
      if (typeof current.getPanelConversationMessages === "function") {
        const panelMessages = current.getPanelConversationMessages(normalizedPanelId);
        if (Array.isArray(panelMessages) && panelMessages.length > 0) return panelMessages;
      }
      return [];
    };
    const setConversationMessagesForPanel = (
      panelId: string,
      messages: TMessage[],
      options?: PanelConversationWriteOptions
    ) => {
      const normalizedPanelId = normalizePanelId(panelId);
      if (typeof current.setPanelConversationMessages === "function") {
        current.setPanelConversationMessages(normalizedPanelId, messages, options);
        return;
      }
    };
    if (clearInput) {
      current.setTranscript("");
    }
    const activeRequestSeqForCurrentThread = () => {
      const state = getPanelRequestState(requestPanelId);
      if (!state) return 0;
      return requestThreadKey
        ? (state.activeRequestSeqByThreadId[requestThreadKey] || 0)
        : state.activeRequestSeq;
    };
    const isActiveRequest = () => {
      const state = getPanelRequestState(requestPanelId);
      if (!state) return false;
      if (requestThreadKey) {
        return state.activeRequestSeqByThreadId[requestThreadKey] === requestSeq;
      }
      return state.activeRequestSeq === requestSeq;
    };
    const isCancelledRequest = () => {
      const state = getPanelRequestState(requestPanelId);
      if (!state) return false;
      if (requestThreadKey) {
        return state.cancelledRequestSeqByThreadId[requestThreadKey] === requestSeq;
      }
      return state.cancelledRequestSeq === requestSeq;
    };
    const replyRequestStartedAt = Date.now();
    let finalUiSettled = false;
    let trackedThreadId = requestThreadId || requestUiSessionId;
    const panelStreamingAssistantMessageId = `assistant-stream-${requestTraceId}`;
    let nativeDeltaCount = 0;
    let firstDeltaAtMs = 0;
    let lastDeltaAtMs = 0;
    let codexEventCount = 0;
    let lastCodexEvent = "";
    let panelConversationDraft: TMessage[] = [];
    let latestContextUsedPct: number | null = null;
    const logTurnDiag = (event: string, payload: Record<string, unknown> = {}) => {
      current.logSessionDiag(event, {
        requestTraceId,
        requestSeq,
        requestPanelId,
        requestUiSessionId,
        requestThreadId,
        trackedThreadId,
        directory: requestDirectory,
        modelRef: requestModelRef,
        reasoningEffort: requestReasoningEffort,
        requestSnapshotSource,
        panelActiveRequestSeq: getPanelRequestState(requestPanelId)?.activeRequestSeq || 0,
        panelCancelledRequestSeq: getPanelRequestState(requestPanelId)?.cancelledRequestSeq || null,
        requestThreadKey: requestThreadKey || undefined,
        threadActiveRequestSeq: activeRequestSeqForCurrentThread(),
        ...payload,
      }, {
        throttleMs: 0,
        throttleKey: `${event}:${requestSeq}:${Date.now()}`,
      });
    };
    const updateRuntimeRequest = (
      lifecycle: ConversationRuntimeRequestLifecycle,
      status: string,
      statusDetail: string,
      overrides: {
        sessionId?: string;
        threadId?: string;
        updatedAtMs?: number;
        completedAtMs?: number | null;
      } = {}
    ) => {
      if (typeof current.updateConversationRuntimeRequest !== "function") return;
      const sessionId = String(
        overrides.sessionId ||
        trackedThreadId ||
        requestThreadId ||
        requestUiSessionId ||
        ""
      ).trim();
      if (!sessionId) return;
      current.updateConversationRuntimeRequest({
        requestId: requestTraceId,
        requestSeq,
        sessionId,
        sourcePanelId: requestPanelId,
        threadId: String(overrides.threadId || trackedThreadId || requestThreadId || sessionId).trim(),
        lifecycle,
        status,
        statusDetail,
        startedAtMs: replyRequestStartedAt,
        updatedAtMs: overrides.updatedAtMs,
        completedAtMs: overrides.completedAtMs,
      });
    };
    const purgeInFlightStatesForRequest = (targetRequestSeq: number) => {
      if (!Number.isFinite(targetRequestSeq) || targetRequestSeq <= 0) return;
      for (const [threadId, state] of Object.entries(inFlightByThreadRef.current)) {
        if (Number(state?.requestSeq) !== targetRequestSeq) continue;
        delete inFlightByThreadRef.current[threadId];
      }
    };
    const upsertInFlightState = (threadIdRaw: unknown, updater: (prev: InFlightThreadState | null) => InFlightThreadState) => {
      const threadId = String(threadIdRaw || "").trim();
      if (!threadId) return;
      const prev = inFlightByThreadRef.current[threadId];
      const next = updater(prev || null);
      inFlightByThreadRef.current[threadId] = next;
    };
    const moveInFlightStateKey = (fromRaw: unknown, toRaw: unknown) => {
      const from = String(fromRaw || "").trim();
      const to = String(toRaw || "").trim();
      if (!from || !to || from === to) return;
      const state = inFlightByThreadRef.current[from];
      if (!state) return;
      inFlightByThreadRef.current[to] = state;
      delete inFlightByThreadRef.current[from];
    };
    const movePanelRequestThreadKey = (fromRaw: unknown, toRaw: unknown) => {
      const from = String(fromRaw || "").trim();
      const to = String(toRaw || "").trim();
      if (!to || from === to) return;
      const state = getPanelRequestState(requestPanelId);
      if (!state) return;
      if (from && state.activeRequestSeqByThreadId[from] === requestSeq) {
        state.activeRequestSeqByThreadId[to] = requestSeq;
        delete state.activeRequestSeqByThreadId[from];
      } else if (!from) {
        state.activeRequestSeqByThreadId[to] = requestSeq;
      }
      if (from && state.cancelledRequestSeqByThreadId[from] === requestSeq) {
        state.cancelledRequestSeqByThreadId[to] = requestSeq;
        delete state.cancelledRequestSeqByThreadId[from];
      }
      const inFlight = from ? state.inFlightTurnRequestByThreadId[from] : null;
      if (inFlight?.requestSeq === requestSeq) {
        state.inFlightTurnRequestByThreadId[to] = {
          ...inFlight,
          threadId: to,
        };
        delete state.inFlightTurnRequestByThreadId[from];
      }
      if (state.activeRequestSeq === requestSeq) {
        state.activeRequestThreadId = to;
      }
      requestThreadKey = to;
    };
    const buildPanelConversationWriteOptions = (
      options?: PanelConversationWriteOptions
    ): PanelConversationWriteOptions => ({
      sessionId: String(
        options?.sessionId ||
        trackedThreadId ||
        requestThreadId ||
        requestUiSessionId ||
        ""
      ).trim(),
      contextUsedPct: options?.contextUsedPct,
      isResponding: options?.isResponding ?? true,
      selectedThreadStatusType: options?.selectedThreadStatusType,
      adoptFromSessionId: options?.adoptFromSessionId,
      clearRespondingRequestStartedAtMs: options?.clearRespondingRequestStartedAtMs,
    });
    const hasRenderableAssistantMessage = (contentRaw: string, extra: Record<string, unknown>) => {
      if (String(contentRaw || "").trim()) return true;
      if (Array.isArray(extra.youtubeVideoIds) && extra.youtubeVideoIds.length > 0) return true;
      return String(extra.llmStatus || "") === "error";
    };
    const updatePanelLiveAssistantMessage = (
      contentRaw: string,
      extra: Record<string, unknown> = {},
      options?: PanelConversationWriteOptions,
      messageIdRaw?: string
    ) => {
      const messageId = String(messageIdRaw || panelStreamingAssistantMessageId).trim() || panelStreamingAssistantMessageId;
      if (!hasRenderableAssistantMessage(contentRaw, extra)) {
        if (options?.isResponding === false) {
          setConversationMessagesForPanel(
            requestPanelId,
            panelConversationDraft.length > 0
              ? panelConversationDraft
              : getConversationMessagesForPanel(requestPanelId),
            buildPanelConversationWriteOptions(options)
          );
        }
        return;
      }
      const latestConversation = panelConversationDraft.length > 0
        ? panelConversationDraft
        : getConversationMessagesForPanel(requestPanelId);
      const content = String(contentRaw || "");
      const nextMessage = current.buildConversationMessage("assistant", content, {
        id: messageId,
        ...extra,
      });
      let replaced = false;
      const nextConversationForPanel = latestConversation.map((message) => {
        if (String(message.id || "") !== messageId) return message;
        replaced = true;
        return nextMessage;
      });
      if (!replaced) {
        nextConversationForPanel.push(nextMessage);
      }
      panelConversationDraft = nextConversationForPanel;
      setConversationMessagesForPanel(
        requestPanelId,
        nextConversationForPanel,
        buildPanelConversationWriteOptions(options)
      );
    };
    if (trackedThreadId) {
      upsertInFlightState(trackedThreadId, (prev) => ({
        requestId: requestTraceId,
        requestSeq,
        panelId: prev?.panelId || requestPanelId,
        startedAt: prev?.startedAt || replyRequestStartedAt,
        status: "connecting",
        statusDetail: "Codex app-server WebSocket connecting",
        replyBuffer: prev?.replyBuffer || "",
      }));
    }
    updateRuntimeRequest("active", "connecting", "Codex app-server WebSocket connecting");
    current.logAuto("reply_http_start", {
      transcriptChars: effectiveTranscript.length,
    });
    logTurnDiag("reply_http_request_start", {
      transcriptChars: effectiveTranscript.length,
      replyLoading: current.replyLoadingRef.current,
      hasThreadId: !!requestThreadId,
    });
    const nextConversation = [
      ...getConversationMessagesForPanel(requestPanelId),
      current.buildConversationMessage("user", effectiveTranscript, requestOptions?.sttMeta
        ? { sttMeta: requestOptions.sttMeta }
        : undefined),
    ];
    panelConversationDraft = nextConversation;
    setConversationMessagesForPanel(requestPanelId, nextConversation, {
      isResponding: true,
      sessionId: String(requestThreadId || requestUiSessionId || "").trim(),
    });
    updatePanelLiveAssistantMessage("", {
      llmStatus: "connecting",
      llmStatusDetail: "Codex app-server WebSocket connecting",
    }, {
      isResponding: true,
      selectedThreadStatusType: "active",
      sessionId: String(requestThreadId || requestUiSessionId || "").trim(),
    });

    let codexReplyBuffer = "";
    let currentAgentMessageItemId = "";
    const agentMessageOrder: string[] = [];
    const agentMessageContentById = new Map<string, string>();
    const agentMessageUiIdByItemId = new Map<string, string>();
    const extractAgentMessageItemId = (paramsRaw: unknown) => {
      const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw as any : {};
      return String(params?.item?.id || params?.itemId || "").trim();
    };
    const rememberAgentMessageItemId = (itemIdRaw: string) => {
      const itemId = String(itemIdRaw || "").trim();
      if (!itemId) return "";
      if (!agentMessageContentById.has(itemId)) {
        agentMessageContentById.set(itemId, "");
        agentMessageOrder.push(itemId);
      }
      if (!agentMessageUiIdByItemId.has(itemId)) {
        agentMessageUiIdByItemId.set(itemId, `assistant-stream-${requestTraceId}-${itemId}`);
      }
      currentAgentMessageItemId = itemId;
      return itemId;
    };
    const resolveAgentMessageItemId = (paramsRaw: unknown) => {
      const fromParams = extractAgentMessageItemId(paramsRaw);
      if (fromParams) return rememberAgentMessageItemId(fromParams);
      if (currentAgentMessageItemId) return rememberAgentMessageItemId(currentAgentMessageItemId);
      return rememberAgentMessageItemId("__agent_message__");
    };
    const rebuildCodexReplyBufferFromAgentMessages = () => {
      codexReplyBuffer = agentMessageOrder
        .map((itemId) => String(agentMessageContentById.get(itemId) || "").trim())
        .filter(Boolean)
        .join("\n\n");
      return codexReplyBuffer;
    };
    const hasLiveAgentMessages = () => agentMessageOrder.some((itemId) => (
      String(agentMessageContentById.get(itemId) || "").trim()
    ));
    const getLastLiveAgentMessage = () => {
      for (let index = agentMessageOrder.length - 1; index >= 0; index -= 1) {
        const itemId = agentMessageOrder[index];
        const content = String(agentMessageContentById.get(itemId) || "").trim();
        if (!content) continue;
        const messageId = agentMessageUiIdByItemId.get(itemId);
        if (messageId) return { content, messageId };
      }
      return null;
    };
    const updatePanelLiveAgentMessage = (
      itemIdRaw: string,
      contentRaw: string,
      extra: Record<string, unknown> = {},
      options?: PanelConversationWriteOptions
    ) => {
      const itemId = rememberAgentMessageItemId(itemIdRaw);
      const messageId = itemId ? agentMessageUiIdByItemId.get(itemId) : panelStreamingAssistantMessageId;
      updatePanelLiveAssistantMessage(contentRaw, extra, options, messageId);
    };
    const settlePanelLiveAgentMessages = (
      extra: Record<string, unknown>,
      options?: PanelConversationWriteOptions
    ) => {
      const liveMessageIds = new Set(Array.from(agentMessageUiIdByItemId.values()));
      if (liveMessageIds.size <= 0) return false;
      const latestConversation = panelConversationDraft.length > 0
        ? panelConversationDraft
        : getConversationMessagesForPanel(requestPanelId);
      const lastLiveMessageId = Array.from(liveMessageIds).pop() || "";
      const settledStatus = String(extra.llmStatus || "completed") as LlmUiStatus;
      const settledStatusDetail = settledStatus === "completed"
        ? ""
        : String(extra.llmStatusDetail || "");
      const nextConversationForPanel = latestConversation.map((message) => {
        const messageId = String(message.id || "");
        if (!liveMessageIds.has(messageId)) return message;
        const liveMessage = message as TMessage & {
          llmStatus?: string;
          llmElapsedMs?: number;
          youtubeVideoIds?: string[];
        };
        // Messages already settled as "completed" (per-item settle while the
        // turn keeps running) must not be downgraded when the turn later errors.
        if (settledStatus === "error" && String(liveMessage.llmStatus || "") === "completed") {
          return message;
        }
        return {
          ...message,
          llmStatus: settledStatus,
          llmStatusDetail: settledStatusDetail,
          llmElapsedMs: messageId === lastLiveMessageId && Number.isFinite(Number(extra.llmElapsedMs))
            ? Number(extra.llmElapsedMs)
            : liveMessage.llmElapsedMs,
          youtubeVideoIds: messageId === lastLiveMessageId &&
            Array.isArray(extra.youtubeVideoIds) &&
            !(liveMessage.youtubeVideoIds && liveMessage.youtubeVideoIds.length > 0)
            ? (extra.youtubeVideoIds as string[])
            : liveMessage.youtubeVideoIds,
        };
      });
      panelConversationDraft = nextConversationForPanel;
      setConversationMessagesForPanel(
        requestPanelId,
        nextConversationForPanel,
        buildPanelConversationWriteOptions(options)
      );
      return true;
    };
    try {
      void current.uploadCodexWsPreflightLog({
        phase: "send_before_ws_connect",
        targetWsUrl: targetCodexWsUrl,
        targetWsToken: current.codexWsToken.trim(),
        extra: {
          transcriptChars: effectiveTranscript.length,
        },
      }).catch(() => {
        // preflight is best-effort diagnostics
      });
      if (!isActiveRequest() || isCancelledRequest()) return;

      logTurnDiag("reply_http_codex_ws_connect_start", {
        wsUrl: targetCodexWsUrl,
        strictThreadResume: !!requestThreadId,
        hasRequestSnapshot: !!requestSnapshot,
      });
      const projectApprovalRequest = (request: ApprovalRequest): ApprovalRequest => ({
        ...request,
        sessionInfo: {
          panelId: requestPanelId,
          sessionId: String(requestSnapshot?.sessionId || request.threadId || requestThreadId || requestUiSessionId || "").trim(),
          directoryPath: requestDirectory,
          directoryDisplayName: String(requestSnapshot?.directoryDisplayName || "").trim(),
          sessionTitle: String(requestSnapshot?.sessionTitle || "").trim(),
        },
      });
      const createTurnSession = (attempt: number) => startCodexAppServerTurn({
        wsUrl: targetCodexWsUrl,
        wsToken: current.codexWsToken.trim(),
        runnerWebSocketManager: current.runnerWebSocketManager,
        traceId: requestTraceId,
        inputText: effectiveTranscript,
        cwd: requestDirectory || undefined,
        threadId: requestThreadId || undefined,
        strictThreadResume: !!requestThreadId,
        serviceName: "expo-ios-client",
        model: requestModelRef || undefined,
        effort: requestModelRef ? requestReasoningEffort : undefined,
        approvalPolicy: current.codexApprovalPolicy,
        onApprovalRequest: (request) => current.handleApprovalRequest(projectApprovalRequest(request)),
        onApprovalRequestResolved: (request) => {
          current.onApprovalRequestResolved?.(projectApprovalRequest(request));
        },
        onThreadIdResolved: (threadId) => {
          if (!isActiveRequest() || isCancelledRequest()) return;
          const resolvedThreadId = String(threadId || "").trim();
          if (!resolvedThreadId) return;
          current.rememberKnownCodexThreadId?.(resolvedThreadId);
          const previousThreadKey = requestThreadKey;
          if (requestThreadKey !== resolvedThreadId) {
            movePanelRequestThreadKey(requestThreadKey, resolvedThreadId);
          }
          if (!trackedThreadId) {
            trackedThreadId = resolvedThreadId;
          } else if (trackedThreadId !== resolvedThreadId) {
            moveInFlightStateKey(trackedThreadId, resolvedThreadId);
            trackedThreadId = resolvedThreadId;
          }
          setConversationMessagesForPanel(
            requestPanelId,
            panelConversationDraft.length > 0
              ? panelConversationDraft
              : getConversationMessagesForPanel(requestPanelId),
            buildPanelConversationWriteOptions({
              sessionId: resolvedThreadId,
              adoptFromSessionId: requestSessionAdoptionSourceId,
            })
          );
          logTurnDiag("reply_http_thread_resolved", {
            resolvedThreadId,
            previousTrackedThreadId: previousThreadKey,
          });
          const activePanelState = getPanelRequestState(requestPanelId);
          if (activePanelState?.inFlightTurnRequest?.requestSeq === requestSeq) {
            activePanelState.inFlightTurnRequest = {
              ...activePanelState.inFlightTurnRequest,
              panelId: requestPanelId,
              threadId: resolvedThreadId,
            };
          }
          if (activePanelState?.inFlightTurnRequestByThreadId[resolvedThreadId]?.requestSeq === requestSeq) {
            activePanelState.inFlightTurnRequestByThreadId[resolvedThreadId] = {
              ...activePanelState.inFlightTurnRequestByThreadId[resolvedThreadId],
              panelId: requestPanelId,
              threadId: resolvedThreadId,
            };
          }
          upsertInFlightState(resolvedThreadId, (prev) => ({
            requestId: requestTraceId,
            requestSeq,
            panelId: prev?.panelId || requestPanelId,
            startedAt: prev?.startedAt || replyRequestStartedAt,
            status: prev?.status || "connecting",
            statusDetail: prev?.statusDetail || "Codex app-server WebSocket connecting",
            replyBuffer: prev?.replyBuffer || codexReplyBuffer,
          }));
          updateRuntimeRequest("active", "model_processing", "thread resolved", {
            sessionId: resolvedThreadId,
            threadId: resolvedThreadId,
          });
        },
        onLog: (entry) => {
          logTurnDiag("reply_http_codex_ws_log", {
            attempt,
            stage: entry.stage,
            method: entry.method || "",
            id: Number.isFinite(Number(entry.id)) ? Number(entry.id) : null,
            readyState: Number.isFinite(Number(entry.readyState)) ? Number(entry.readyState) : null,
            message: entry.message || "",
          });
        },
        onEvent: (method, params) => {
          if (method) {
            codexEventCount += 1;
            lastCodexEvent = String(method || "");
          }
          if (!method) return;
          if (!isActiveRequest() || isCancelledRequest()) return;
          const payload = params && typeof params === "object" ? params as Record<string, unknown> : {};
          if (method === "item/started" && String((payload as any)?.item?.type || "") === "agentMessage") {
            rememberAgentMessageItemId(extractAgentMessageItemId(payload));
          }
          const threadStatus = method === "thread/status/changed"
            ? deriveCodexSessionStateFromSnapshot({
              status: payload.status ?? (payload as any)?.thread?.status,
            })
            : null;
          const nextPanelStatus = (() => {
            if (method === "thread/status/changed") {
              if (threadStatus?.sessionState === "waiting_on_approval") {
                return {
                  status: "tool_waiting_approval" as LlmUiStatus,
                  detail: "thread active: waiting_on_approval",
                  threadStatusType: "waiting_approval",
                };
              }
              if (threadStatus?.sessionState === "running") {
                return {
                  status: "model_processing" as LlmUiStatus,
                  detail: "thread active",
                  threadStatusType: threadStatus.threadStatusType,
                };
              }
            }
            if (method === "turn/started") {
              return {
                status: "model_processing" as LlmUiStatus,
                detail: "turn started",
                threadStatusType: "active",
              };
            }
            if (method === "turn/completed") {
              return {
                status: "completed" as LlmUiStatus,
                detail: "turn completed",
                threadStatusType: "idle",
              };
            }
            return null;
          })();
          if (nextPanelStatus) {
            const nextPanelReply = current.applyAssistantReply(codexReplyBuffer);
            const writeOptions = {
              isResponding: true,
              selectedThreadStatusType: String(nextPanelStatus.threadStatusType || "").trim() || undefined,
              sessionId: String(trackedThreadId || requestThreadId || requestUiSessionId || "").trim(),
            };
            if (hasLiveAgentMessages()) {
              setConversationMessagesForPanel(
                requestPanelId,
                panelConversationDraft.length > 0
                  ? panelConversationDraft
                  : getConversationMessagesForPanel(requestPanelId),
                buildPanelConversationWriteOptions(writeOptions)
              );
            } else {
              updatePanelLiveAssistantMessage(nextPanelReply, {
                llmStatus: nextPanelStatus.status,
                llmStatusDetail: nextPanelStatus.detail,
              }, writeOptions);
            }
            if (trackedThreadId) {
              upsertInFlightState(trackedThreadId, (prev) => {
                if (prev && prev.requestSeq !== requestSeq) return prev;
                return {
                  requestId: requestTraceId,
                  requestSeq,
                  panelId: prev?.panelId || requestPanelId,
                  startedAt: prev?.startedAt || replyRequestStartedAt,
                  status: nextPanelStatus.status,
                  statusDetail: nextPanelStatus.detail,
                  replyBuffer: codexReplyBuffer || prev?.replyBuffer || "",
                };
              });
            }
            updateRuntimeRequest("active", nextPanelStatus.status, nextPanelStatus.detail);
          }
        },
        onDelta: (delta: string, params?: unknown) => {
          if (!isActiveRequest() || isCancelledRequest()) return;
          const normalizedDelta = String(delta || "");
          if (!normalizedDelta) return;
          const itemId = resolveAgentMessageItemId(params);
          const nextItemContent = `${String(agentMessageContentById.get(itemId) || "")}${normalizedDelta}`;
          agentMessageContentById.set(itemId, nextItemContent);
          rebuildCodexReplyBufferFromAgentMessages();
          nativeDeltaCount += 1;
          const deltaAtMs = Date.now();
          if (firstDeltaAtMs <= 0) {
            firstDeltaAtMs = deltaAtMs;
            logTurnDiag("reply_http_first_delta", {
              deltaChars: normalizedDelta.length,
              replyBufferChars: codexReplyBuffer.length,
              firstDeltaAfterMs: Math.max(0, deltaAtMs - replyRequestStartedAt),
            });
          }
          lastDeltaAtMs = deltaAtMs;
          if (trackedThreadId) {
            upsertInFlightState(trackedThreadId, (prev) => {
              if (prev && prev.requestSeq !== requestSeq) return prev;
              return {
                requestId: requestTraceId,
                requestSeq,
                panelId: prev?.panelId || requestPanelId,
                startedAt: prev?.startedAt || replyRequestStartedAt,
                status: "model_generating",
                statusDetail: "delta:native",
                replyBuffer: codexReplyBuffer,
              };
            });
          }
          updatePanelLiveAgentMessage(itemId, current.applyAssistantReply(nextItemContent), {
            llmStatus: "model_generating",
            llmStatusDetail: "delta:native",
          });
          updateRuntimeRequest("active", "model_generating", "delta:native");
        },
        onAgentMessageCompleted: (text, params) => {
          if (!isActiveRequest() || isCancelledRequest()) return;
          const finalText = String(text || "");
          if (!finalText.trim()) return;
          const itemId = resolveAgentMessageItemId(params);
          agentMessageContentById.set(itemId, finalText);
          rebuildCodexReplyBufferFromAgentMessages();
          const youtubeIds = current.extractYouTubeVideoIds(finalText);
          void current.fetchYouTubeVideoMetadata(youtubeIds);
          updatePanelLiveAgentMessage(itemId, current.applyAssistantReply(finalText), {
            llmStatus: "completed",
            llmStatusDetail: "",
            youtubeVideoIds: youtubeIds,
            llmElapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
          }, {
            isResponding: true,
            selectedThreadStatusType: "active",
            sessionId: String(trackedThreadId || requestThreadId || requestUiSessionId || "").trim(),
          });
          updateRuntimeRequest("active", "model_processing", "agent message completed");
        },
      });
      let turnAttempt = 1;
      let turnSession = createTurnSession(turnAttempt);
      const initialInFlightTurnRequest = {
        requestId: requestTraceId,
        requestSeq,
        panelId: requestPanelId,
        session: turnSession,
        threadId: trackedThreadId,
        startedAt: replyRequestStartedAt,
      };
      panelRequestState.inFlightTurnRequest = initialInFlightTurnRequest;
      if (requestThreadKey) {
        panelRequestState.inFlightTurnRequestByThreadId[requestThreadKey] = initialInFlightTurnRequest;
      }
      let result: CodexAppServerTurnResult;
      try {
        result = await turnSession.promise;
      } catch (error) {
        if (
          turnAttempt >= 2 ||
          !isThreadResumeRpcTimeout(error) ||
          !isActiveRequest() ||
          isCancelledRequest() ||
          nativeDeltaCount > 0
        ) {
          throw error;
        }
        logTurnDiag("reply_http_retry", {
          reason: "thread_resume_rpc_timeout",
          attempt: turnAttempt,
          nextAttempt: turnAttempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        turnAttempt += 1;
        codexReplyBuffer = "";
        turnSession = createTurnSession(turnAttempt);
        const retryInFlightTurnRequest = {
          requestId: requestTraceId,
          requestSeq,
          panelId: requestPanelId,
          session: turnSession,
          threadId: trackedThreadId,
          startedAt: replyRequestStartedAt,
        };
        panelRequestState.inFlightTurnRequest = retryInFlightTurnRequest;
        if (requestThreadKey) {
          panelRequestState.inFlightTurnRequestByThreadId[requestThreadKey] = retryInFlightTurnRequest;
        }
        result = await turnSession.promise;
      }
      if (!isActiveRequest() || isCancelledRequest()) return;
      if (!trackedThreadId) {
        const resolvedThreadId = String(result.threadId || "").trim();
        if (resolvedThreadId) {
          current.rememberKnownCodexThreadId?.(resolvedThreadId);
          movePanelRequestThreadKey(requestThreadKey, resolvedThreadId);
          trackedThreadId = resolvedThreadId;
        }
      } else {
        const resolvedThreadId = String(result.threadId || "").trim();
        if (resolvedThreadId && resolvedThreadId !== trackedThreadId) {
          current.rememberKnownCodexThreadId?.(resolvedThreadId);
          movePanelRequestThreadKey(requestThreadKey, resolvedThreadId);
          moveInFlightStateKey(trackedThreadId, resolvedThreadId);
          trackedThreadId = resolvedThreadId;
        }
      }
      let contextUsedPct = current.parseContextUsageUsedPct(result.contextUsage);
      if (contextUsedPct === null) {
        contextUsedPct = await current.fetchRunnerSessionContextUsedPct(
          result.threadId,
          requestDirectory
        ).catch(() => null);
      }
      latestContextUsedPct = contextUsedPct;
      current.logAuto("reply_http_done", {
        elapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
        status: 200,
        toolCalls: null,
      });
      const nextReplyRaw = String(result.reply || codexReplyBuffer || "");
      logTurnDiag("reply_http_result", {
        elapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
        resultThreadId: result.threadId || "",
        turnId: result.turnId || "",
        resultReplyChars: String(result.reply || "").length,
        bufferedReplyChars: codexReplyBuffer.length,
        replyChars: nextReplyRaw.length,
        nativeDeltaCount,
        codexEventCount,
        lastCodexEvent,
        firstDeltaAfterMs: firstDeltaAtMs > 0 ? Math.max(0, firstDeltaAtMs - replyRequestStartedAt) : null,
        lastDeltaAfterMs: lastDeltaAtMs > 0 ? Math.max(0, lastDeltaAtMs - replyRequestStartedAt) : null,
      });
      if (!nextReplyRaw.trim()) {
        logTurnDiag("reply_http_empty_reply_result", {
          elapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
          resultThreadId: result.threadId || "",
          turnId: result.turnId || "",
          nativeDeltaCount,
          codexEventCount,
          lastCodexEvent,
        });
      }
      const youtubeIds = current.extractYouTubeVideoIds(nextReplyRaw);
      void current.fetchYouTubeVideoMetadata(youtubeIds);
      const nextReply = current.stripYouTubeTags(nextReplyRaw);
      const nextReplyForHistory = nextReply || (youtubeIds.length > 0 ? "YouTube動画候補を表示しました。" : "");
      const finalReplySessionId = String(result.threadId || trackedThreadId || requestThreadId || requestUiSessionId || "").trim();
      updateRuntimeRequest("completed", "completed", "reply received", {
        sessionId: finalReplySessionId,
        threadId: String(result.threadId || finalReplySessionId).trim(),
        completedAtMs: Date.now(),
      });
      void current.uploadCodexWsPreflightLog({
        phase: "send_after_reply_ok",
        targetWsUrl: targetCodexWsUrl,
        targetWsToken: current.codexWsToken.trim(),
        extra: {
          threadId: result.threadId || "",
          turnId: result.turnId || "",
          replyChars: nextReplyRaw.length,
        },
      });
      const elapsedMs = Math.max(0, Date.now() - replyRequestStartedAt);
      const settledLiveMessages = settlePanelLiveAgentMessages({
        youtubeVideoIds: youtubeIds,
        llmStatus: "completed",
        llmStatusDetail: "reply received",
        llmElapsedMs: elapsedMs,
      }, {
        contextUsedPct,
        isResponding: false,
        selectedThreadStatusType: "idle",
        sessionId: finalReplySessionId,
        adoptFromSessionId: requestSessionAdoptionSourceId,
      });
      if (!settledLiveMessages) {
        updatePanelLiveAssistantMessage(nextReply, {
          youtubeVideoIds: youtubeIds,
          llmStatus: "completed",
          llmStatusDetail: "reply received",
          llmElapsedMs: elapsedMs,
        }, {
          contextUsedPct,
          isResponding: false,
          selectedThreadStatusType: "idle",
          sessionId: finalReplySessionId,
          adoptFromSessionId: requestSessionAdoptionSourceId,
        });
      }
      finalUiSettled = true;
      const lastLiveAgentMessage = getLastLiveAgentMessage();
      const finalReplyForSpeech = current.stripYouTubeTags(lastLiveAgentMessage?.content || "");
      void current.onLlmMessageCompleted?.({
        sessionId: finalReplySessionId,
        threadId: String(result.threadId || finalReplySessionId).trim(),
        directory: requestDirectory,
        previewText: finalReplyForSpeech || current.stripYouTubeTags(nextReplyForHistory || nextReplyRaw),
        completedAtMs: Date.now(),
      });
      const autoSpeechTarget = {
        panelId: requestPanelId,
        sessionId: finalReplySessionId,
        messageId: lastLiveAgentMessage?.messageId || panelStreamingAssistantMessageId,
      };
      const chatOpenForAutoSpeech = current.isChatOpenForAutoSpeech
        ? current.isChatOpenForAutoSpeech(autoSpeechTarget)
        : true;
      if (
        current.autoSpeakAfterReply &&
        finalReplyForSpeech &&
        chatOpenForAutoSpeech
      ) {
        await current.synthesizeSpeechStream(finalReplyForSpeech, autoSpeechTarget);
      } else if (current.autoSpeakAfterReply && finalReplyForSpeech && !chatOpenForAutoSpeech) {
        logTurnDiag("reply_http_auto_speech_skipped", {
          reason: "chat_not_open",
          panelId: requestPanelId || undefined,
          sessionId: finalReplySessionId || undefined,
          messageId: autoSpeechTarget.messageId,
        });
      }
      if (trackedThreadId) {
        delete inFlightByThreadRef.current[trackedThreadId];
      }
    } catch (error) {
      if (isCodexAppServerTurnInterruptedError(error) || isCancelledRequest()) {
        const interruptedAtMs = Date.now();
        updateRuntimeRequest(
          isCancelledRequest() ? "cancelled" : "interrupted",
          "idle",
          isCancelledRequest() ? "cancelled" : "interrupted",
          { completedAtMs: interruptedAtMs }
        );
        if (trackedThreadId) {
          delete inFlightByThreadRef.current[trackedThreadId];
        }
        if (isActiveRequest()) {
          logTurnDiag("reply_http_interrupted", {
            interrupted: true,
            finalUiSettled,
          });
          // finalUiSettled は立てない: このパスには isResponding:false を書く settle 処理がなく、
          // finally の setConversationMessagesForPanel が isResponding を確定させる唯一の書き込み。
        }
        return;
      }
      if (!isActiveRequest()) return;
      console.error("[reply] error", error);
      current.logAuto("reply_http_error", {
        elapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
        message: error instanceof Error ? error.message : String(error),
      });
      logTurnDiag("reply_http_error", {
        elapsedMs: Math.max(0, Date.now() - replyRequestStartedAt),
        message: error instanceof Error ? error.message : String(error),
        nativeDeltaCount,
        codexEventCount,
        lastCodexEvent,
      });
      void current.uploadCodexWsPreflightLog({
        phase: "send_after_reply_error",
        targetWsUrl: targetCodexWsUrl,
        targetWsToken: current.codexWsToken.trim(),
        extra: {
          message: error instanceof Error ? error.message : String(error),
          model: requestModelRef,
          effort: requestReasoningEffort,
          threadId: requestThreadId,
        },
      });
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateRuntimeRequest("error", "error", current.trimForInline(errorMessage, 220), {
        completedAtMs: Date.now(),
      });
      const errorWriteOptions = {
        isResponding: false,
        selectedThreadStatusType: "idle",
        sessionId: String(trackedThreadId || requestThreadId || requestUiSessionId || "").trim(),
        adoptFromSessionId: requestSessionAdoptionSourceId,
      };
      if (hasLiveAgentMessages()) {
        settlePanelLiveAgentMessages({
          llmStatus: "error",
          llmStatusDetail: current.trimForInline(errorMessage, 220),
        }, errorWriteOptions);
      } else {
        updatePanelLiveAssistantMessage(current.applyAssistantReply(codexReplyBuffer), {
          llmStatus: "error",
          llmStatusDetail: current.trimForInline(errorMessage, 220),
        }, errorWriteOptions);
      }
      finalUiSettled = true;
      if (trackedThreadId) {
        delete inFlightByThreadRef.current[trackedThreadId];
      }
    } finally {
      purgeInFlightStatesForRequest(requestSeq);
      const clearedRequestTracking = clearPanelRequestTracking(requestPanelId, requestSeq, requestThreadKey);
      const isFinalPanelActive = clearedRequestTracking.clearedPanelActive;
      const isFinalThreadActive = clearedRequestTracking.clearedThreadActive;
      if (isFinalPanelActive || isFinalThreadActive) {
        logTurnDiag("reply_http_finally", {
          finalUiSettled,
          finalPanelActive: isFinalPanelActive,
          finalThreadActive: isFinalThreadActive,
          finalPanelInFlight: clearedRequestTracking.clearedPanelInFlight,
          finalThreadInFlight: clearedRequestTracking.clearedThreadInFlight,
          nativeDeltaCount,
          codexEventCount,
          lastCodexEvent,
          firstDeltaAfterMs: firstDeltaAtMs > 0 ? Math.max(0, firstDeltaAtMs - replyRequestStartedAt) : null,
          lastDeltaAfterMs: lastDeltaAtMs > 0 ? Math.max(0, lastDeltaAtMs - replyRequestStartedAt) : null,
        });
        if (!finalUiSettled) {
          setConversationMessagesForPanel(
            requestPanelId,
            panelConversationDraft.length > 0
              ? panelConversationDraft
              : getConversationMessagesForPanel(requestPanelId),
            {
              isResponding: false,
              selectedThreadStatusType: "idle",
              clearRespondingRequestStartedAtMs: replyRequestStartedAt,
              ...(latestContextUsedPct !== null ? { contextUsedPct: latestContextUsedPct } : {}),
              sessionId: String(trackedThreadId || requestThreadId || requestUiSessionId || "").trim(),
              adoptFromSessionId: requestSessionAdoptionSourceId,
            }
          );
        }
      }
    }
  }, [clearPanelRequestTracking, getPanelRequestState]);

  const cancelReplyRequest = useCallback(async (options?: { panelId?: string }) => {
    const current = optionsRef.current;
    const targetPanelId = normalizePanelId(options?.panelId);
    const targetThreadId = "";
    const {
      panelState: targetPanelState,
      inFlight,
      requestSeq: targetRequestSeq,
      ownerPanelId,
      sessionId: cancelledSessionId,
    } = resolveRequestControlTarget(targetPanelId, targetThreadId);
    if (targetRequestSeq <= 0) return false;
    if (ownerPanelId !== targetPanelId) {
      current.logAuto("reply_http_cancel_skipped_panel_mismatch", {
        requestSeq: targetRequestSeq,
        ownerPanelId,
        targetPanelId,
      });
      return false;
    }
    if (targetPanelState) {
      targetPanelState.cancelledRequestSeq = targetRequestSeq;
      if (targetThreadId) {
        targetPanelState.cancelledRequestSeqByThreadId[targetThreadId] = targetRequestSeq;
      }
    }
    current.logAuto("reply_http_cancel_requested", {
      requestSeq: targetRequestSeq,
      panelId: targetPanelId,
    });
    const cancelledAtMs = Date.now();
    if (cancelledSessionId && typeof current.updateConversationRuntimeRequest === "function") {
      current.updateConversationRuntimeRequest({
        requestId: String(inFlight?.requestId || `reply-cancelled-${targetRequestSeq}`).trim(),
        requestSeq: targetRequestSeq,
        sessionId: cancelledSessionId,
        sourcePanelId: targetPanelId,
        threadId: cancelledSessionId,
        lifecycle: "cancelled",
        status: "idle",
        statusDetail: "cancelled",
        startedAtMs: Number(inFlight?.startedAt || cancelledAtMs),
        updatedAtMs: cancelledAtMs,
        completedAtMs: cancelledAtMs,
      });
    }
    const clearPanelResponding = (threadIdRaw?: unknown) => {
      if (typeof current.setPanelConversationMessages !== "function") return;
      const messages = typeof current.getPanelConversationMessages === "function"
        ? current.getPanelConversationMessages(targetPanelId)
        : [];
      current.setPanelConversationMessages(targetPanelId, messages, {
        isResponding: false,
        selectedThreadStatusType: "idle",
        sessionId: String(threadIdRaw || "").trim(),
      });
    };
    clearPanelResponding(inFlight?.threadId);
    if (!inFlight) {
      clearPanelRequestTracking(targetPanelId, targetRequestSeq, targetThreadId);
      return true;
    }
    try {
      await inFlight.session.interrupt();
      return true;
    } catch (error) {
      current.logAuto("reply_http_cancel_interrupt_error", {
        requestSeq: inFlight.requestSeq,
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    } finally {
      const interruptedThreadId = String(inFlight.threadId || "").trim();
      if (interruptedThreadId) {
        delete inFlightByThreadRef.current[interruptedThreadId];
      }
      clearPanelRequestTracking(targetPanelId, inFlight.requestSeq, interruptedThreadId || targetThreadId);
    }
  }, [clearPanelRequestTracking, resolveRequestControlTarget]);

  const suspendReplyRequest = useCallback((reason = "session_switch", options?: { panelId?: string }) => {
    const current = optionsRef.current;
    const targetPanelId = normalizePanelId(options?.panelId);
    const targetThreadId = "";
    const {
      inFlight,
      requestSeq: targetRequestSeq,
      ownerPanelId,
      sessionId: suspendedSessionId,
    } = resolveRequestControlTarget(targetPanelId, targetThreadId);
    if (targetRequestSeq <= 0) return false;
    if (!inFlight) {
      current.logAuto("reply_http_suspend_skipped_missing_inflight", {
        requestSeq: targetRequestSeq,
        targetPanelId,
        reason: String(reason || "").trim() || "session_switch",
      });
      return false;
    }
    if (ownerPanelId !== targetPanelId) {
      current.logAuto("reply_http_suspend_skipped_panel_mismatch", {
        requestSeq: targetRequestSeq,
        ownerPanelId,
        targetPanelId,
        reason: String(reason || "").trim() || "session_switch",
      });
      return false;
    }
    current.logAuto("reply_http_suspended", {
      requestSeq: targetRequestSeq,
      panelId: targetPanelId,
      threadId: targetThreadId,
      reason: String(reason || "").trim() || "session_switch",
    });
    if (suspendedSessionId && typeof current.updateConversationRuntimeRequest === "function") {
      current.updateConversationRuntimeRequest({
        requestId: String(inFlight?.requestId || `reply-suspended-${targetRequestSeq}`).trim(),
        requestSeq: targetRequestSeq,
        sessionId: suspendedSessionId,
        sourcePanelId: targetPanelId,
        threadId: suspendedSessionId,
        lifecycle: "suspended",
        status: inFlightByThreadRef.current[suspendedSessionId]?.status || "model_processing",
        statusDetail: String(reason || "").trim() || "session_switch",
        startedAtMs: Number(inFlight?.startedAt || Date.now()),
        updatedAtMs: Date.now(),
        completedAtMs: null,
      });
    }
    return true;
  }, [resolveRequestControlTarget]);

  const restoreReplyRequestForThread = useCallback((threadIdRaw: unknown, options?: { panelId?: string }) => {
    const current = optionsRef.current;
    const threadId = String(threadIdRaw || "").trim();
    const targetPanelId = normalizePanelId(options?.panelId);
    if (!threadId) return false;
    const state = inFlightByThreadRef.current[threadId];
    if (!state) return false;
    if (normalizePanelId(state.panelId) !== targetPanelId) {
      current.logAuto("reply_http_restore_skipped_panel_mismatch", {
        threadId,
        requestSeq: state.requestSeq,
        ownerPanelId: normalizePanelId(state.panelId),
        targetPanelId,
      });
      return false;
    }
    const panelState = getPanelRequestState(targetPanelId, true)!;
    const activeRequestSeq = panelState.activeRequestSeqByThreadId[threadId] || 0;
    if (!Number.isFinite(state.requestSeq) || state.requestSeq <= 0 || state.requestSeq !== activeRequestSeq) {
      delete inFlightByThreadRef.current[threadId];
      if (panelState.inFlightTurnRequest?.requestSeq === state.requestSeq) {
        panelState.inFlightTurnRequest = null;
      }
      if (panelState.inFlightTurnRequestByThreadId[threadId]?.requestSeq === state.requestSeq) {
        delete panelState.inFlightTurnRequestByThreadId[threadId];
      }
      current.logAuto("reply_http_restore_skipped_stale", {
        threadId,
        requestSeq: state.requestSeq,
        activeRequestSeq,
      });
      return false;
    }
    panelState.activeRequestSeq = state.requestSeq;
    panelState.activeRequestThreadId = threadId;
    panelState.cancelledRequestSeq = null;
    panelState.cancelledRequestSeqByThreadId[threadId] = null;
    if (typeof current.updateConversationRuntimeRequest === "function") {
      current.updateConversationRuntimeRequest({
        requestId: state.requestId,
        requestSeq: state.requestSeq,
        sessionId: threadId,
        sourcePanelId: targetPanelId,
        threadId,
        lifecycle: "active",
        status: state.status,
        statusDetail: state.statusDetail,
        startedAtMs: state.startedAt,
        updatedAtMs: Date.now(),
        completedAtMs: null,
      });
    }
    current.llmRequestStartedAtRef.current = state.startedAt;
    current.logAuto("reply_http_restored", {
      threadId,
      requestSeq: state.requestSeq,
      panelId: targetPanelId,
      replyChars: state.replyBuffer.length,
    });
    return true;
  }, [getPanelRequestState]);

  return {
    sendReplyRequest,
    cancelReplyRequest,
    suspendReplyRequest,
    restoreReplyRequestForThread,
  };
}
