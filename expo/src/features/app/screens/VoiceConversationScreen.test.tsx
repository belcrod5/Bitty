import { useState, type ReactElement, type ReactNode } from "react";
import { act, fireEvent, render as testingRender, waitFor, within } from "@testing-library/react-native";
import { AppState, Platform, ScrollView, StyleSheet, type AppStateStatus } from "react-native";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { DEFAULT_VISUAL_THEME_ID, VISUAL_THEMES } from "../theme/visualThemes";
import { VoiceConversationScreen } from "./VoiceConversationScreen";

const mockWithTiming = jest.fn((value: number, _config?: unknown, callback?: (finished: boolean) => void) => {
  callback?.(true);
  return value;
});
const mockHistoryHeight = { value: 0 };
const mockHistoryDragActive = { value: false };
const mockAbort = jest.fn(async () => undefined);
const mockStopTtsPlayback = jest.fn(async () => undefined);
const mockSynthesizeSpeechStream = jest.fn(async (_text: string, _target: { messageId: string }): Promise<void> => undefined);
let mockMainTts: { ttsProvider: string; voiceId: string } | null = null;
let mockTurnTts: unknown;
const mockOnClose = jest.fn();
const mockRequest = jest.fn(async (message: { op: string; payload?: { orchestratorId?: string } }) => {
  if (message.op === "voice.orchestrators.list") return { op: "voice.orchestrators.list.result",
    payload: { orchestrators: [{ id: "main", name: "メイン", icon: "", ...mockMainTts },
      { id: "other", name: "調査", icon: "" }], selectedId: "main" } };
  if (message.op === "voice.orchestrators.select") return { op: "voice.orchestrators.select.result",
    payload: { orchestrators: [{ id: "main", name: "メイン", icon: "", ...mockMainTts },
      { id: "other", name: "調査", icon: "" }], selectedId: message.payload?.orchestratorId } };
  if (message.op === "voice.userInput.respond") return { op: "voice.userInput.respond.result", payload: {} };
  if (message.op === "voice.learning.delivery") return { op: "voice.learning.delivery.result",
    payload: { delivery: { items: [], reads: [], inheritedReads: [], readsVerified: true } } };
  throw new Error(`unexpected ${message.op}`);
});
const mockQuestionHandlers = new Map<string, Set<(message: RunnerWsMessage) => void>>();
const mockManager = { connect: jest.fn(async () => undefined), request: mockRequest,
  subscribe: ({ op }: { op: string }, listener: (message: RunnerWsMessage) => void) => {
    if (!mockQuestionHandlers.has(op)) mockQuestionHandlers.set(op, new Set());
    mockQuestionHandlers.get(op)?.add(listener);
    return () => {
      const handlers = mockQuestionHandlers.get(op);
      handlers?.delete(listener);
      if (handlers?.size === 0) mockQuestionHandlers.delete(op);
    };
  },
  subscribeSnapshot: () => () => undefined, getSnapshot: () => ({ connected: true }),
};
let mockManagerVisible = false;
let mockManagerOnClose: (() => void) | null = null;
let mockGeneration = 1;
const mockHookOrchestratorIds: string[] = [];
const mockLogSessionDiag = jest.fn();
const mockVoice = {
  ready: true,
  logicalConversationId: "conversation-one",
  turnStatus: "completed",
  reply: { text: "表示しない返答本文", operationId: "operation-1" } as {
    text: string; operationId: string; outputTokens?: number; completedOrdinal?: number;
  },
  error: "",
  contextStats: { contextUsagePercent: 31 as number | null, unsummarizedMessageCount: 8, memoryCharacterCount: 55 },
  history: [] as { role: "user" | "assistant"; text: string; clientOperationId: string; at?: string; completedOrdinal?: number; sessionSwitched?: boolean }[],
  historyError: "",
  taskChecklist: { status: "present", markdown: "# 最優先\n\n- [ ] 確認する" } as
    { status: "present"; markdown: string } | { status: "missing" | "unavailable" } | null,
  taskChecklistOverview: { status: "present", markdown: "- [ ] 確認する" } as
    { status: "present"; markdown: string } | { status: "pending" | "unavailable" } | null,
  taskChecklistCompletion: null as { sourceHash: string; version: string } | null,
  respondToChecklistCompletion: jest.fn(async (_hash: string, _version: string,
    _decision: "clear" | "keep") => undefined),
  refreshHistory: jest.fn(async () => undefined),
  setError: jest.fn(),
  sendTranscript: jest.fn(async (_text?: string, _onAccepted?: () => void) => undefined),
  interrupt: jest.fn(),
};
const mockStt = {
  active: false,
  phase: "idle",
  start: jest.fn(async () => undefined),
  stop: jest.fn(),
  cancelCorrection: jest.fn(),
  sendCorrectionPreview: jest.fn(),
  beginCorrectionEdit: jest.fn(),
  discardCorrection: jest.fn(),
  setCorrectionText: jest.fn(),
  correctionPreview: null as { editing: boolean; text: string; deadlineMs: number | null;
    parts: { kind: "same"; text: string }[] } | null,
  sendManualTranscript: jest.fn(async (_text: string, onAccepted: () => boolean) => { onAccepted(); }),
  abort: mockAbort,
  disarm: () => mockAbort(),
  getSnapshot: () => ({ desired: mockStt.active ? "listening" : "stopped", observed: mockStt.phase === "recording" ? "recording" : "stopped" }),
  getDraft: () => "",
  controlVersion: 0,
  hasPermission: async () => true,
  setInputMuted: async () => undefined,
};
let mockOnCompleted: ((text: string, operationId: string) => void) | null = null;
let mockOnJob: ((jobId: string, operationId: string) => void) | null = null;
let mockUseActualStreamingStt = false;
const mockNativeSttListeners = new Map<string, (event: any) => void>();
const mockNativeStt = {
  continuationVersion: 1,
  playReadyCue: jest.fn(async () => {}),
  setInputMuted: jest.fn(async (_muted: boolean) => {}),
  start: jest.fn(async (_url: string, _headers: Record<string, string>) => undefined),
  commit: jest.fn(async (_revision: number) => true),
  stop: jest.fn(async () => undefined),
  abort: jest.fn(async () => undefined),
  addListener: jest.fn((name: string, listener: (event: any) => void) => {
    mockNativeSttListeners.set(name, listener);
    return { remove: () => mockNativeSttListeners.delete(name) };
  }),
};
let mockLastSttOptions: { ttsPlaybackActive: boolean; onDiagnostic: (event: string, payload: Record<string, unknown>) => void } | null = null;
type MockFooterProps = {
  voiceContextStats?: unknown;
  transcript: string;
  draftTranscript?: string;
  statusText?: string;
  voiceStatus?: "responding" | "speaking";
  reduceMotion?: boolean;
  phase: string;
  onStop: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onChangeText?: (text: string) => void;
  onEditCorrection?: () => void;
  onDiscardCorrection?: () => void;
  onChangeCorrectionText?: (text: string) => void;
  onSubmit?: (text: string, onAccepted: () => boolean) => Promise<void>;
  onCancelSpeaking?: () => void;
  historyExpanded?: boolean;
  onHistoryToggle?: () => void;
  leadingAccessory?: ReactNode;
  trailingAccessory?: ReactNode;
};
let mockFooterProps: MockFooterProps | null = null;
const mockFooterRenders: { transcript: string; voiceStatus?: "responding" | "speaking" }[] = [];
let mockReduceMotion: boolean | null = false;
const initialPlatform = Platform.OS;

jest.mock("../voiceSounds", () => ({ playVoiceSound: jest.fn(async () => {}) }));
jest.mock("expo-blur", () => {
  const ReactModule = require("react");
  const { View } = require("react-native");
  return { BlurView: (props: Record<string, unknown>) => ReactModule.createElement(View, props) };
});
jest.mock("@expo/vector-icons", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
jest.mock("../hooks/useVoiceConversation", () => ({
  useVoiceConversation: (onCompleted: (text: string, operationId: string) => void,
    onJob: (jobId: string, operationId: string) => void,
    tts: unknown, orchestratorId: string) => {
    mockOnCompleted = onCompleted;
    mockOnJob = onJob;
    mockTurnTts = tts;
    mockHookOrchestratorIds.push(orchestratorId);
    return mockVoice;
  },
}));
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => ({ connected: true, generation: mockGeneration }),
}));
jest.mock("../components/VoiceOrchestratorManager", () => ({
  VoiceOrchestratorManager: ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
    mockManagerVisible = visible;
    mockManagerOnClose = onClose;
    return null;
  },
}));
jest.mock("../../stt/useStreamingStt", () => ({ useStreamingStt: (options: { ttsPlaybackActive: boolean; onDiagnostic: (event: string, payload: Record<string, unknown>) => void }) => {
  mockLastSttOptions = options;
  if (mockUseActualStreamingStt) return jest.requireActual("../../stt/useStreamingStt").useStreamingStt(options);
  return mockStt;
} }));
jest.mock("../../stt/sttSettingsClient", () => ({
  correctSttTranscript: jest.fn(async (_url: string, _token: string, text: string) => ({ changed: false, text })),
}));
jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => mockReduceMotion }));
jest.mock("../components/StreamingSttFooter", () => ({
  StreamingSttFooter: (props: MockFooterProps) => {
    const ReactModule = require("react");
    const { Text, TouchableOpacity, View } = require("react-native");
    mockFooterProps = { ...props, draftTranscript: props.transcript, transcript: props.statusText || props.transcript };
    mockFooterRenders.push({ transcript: props.statusText || props.transcript, voiceStatus: props.voiceStatus });
    return ReactModule.createElement(View, { testID: "streaming-stt-footer" },
      ReactModule.createElement(Text, null, props.statusText || props.transcript),
      ReactModule.createElement(TouchableOpacity, { testID: "streaming-stt-stop", onPress: props.onStop }),
      props.leadingAccessory,
      ReactModule.createElement(View, { testID: "streaming-stt-trailing-accessory" }, props.trailingAccessory));
  },
}));
jest.mock("../components/CodexStatusSummaryMenu", () => ({
  CodexStatusSummaryMenu: () => {
    const ReactModule = require("react");
    const { View } = require("react-native");
    return ReactModule.createElement(View, { testID: "codex-status-summary-menu" });
  },
}));
jest.mock("../keyboardController", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return { KeyboardAvoidingView: (props: Record<string, unknown>) => ReactModule.createElement(View, props) };
});
jest.mock("react-native-gesture-handler", () => ({
  Gesture: { Pan: () => {
    const gesture: Record<string, any> = {};
    gesture.enabled = (value: boolean) => { gesture.isEnabled = value; return gesture; };
    gesture.activeOffsetY = (range: number[]) => { gesture.verticalRange = range; return gesture; };
    gesture.failOffsetX = (range: number[]) => { gesture.horizontalRange = range; return gesture; };
    gesture.onStart = (callback: () => void) => { gesture.start = callback; return gesture; };
    gesture.onUpdate = (callback: (event: { translationY: number }) => void) => { gesture.update = callback; return gesture; };
    gesture.onFinalize = (callback: (event: { translationY: number }, success: boolean) => void) => {
      gesture.finalize = callback;
      return gesture;
    };
    return gesture;
  } },
  GestureDetector: ({ gesture, children }: { gesture: Record<string, any>; children: React.ReactElement }) => {
    const ReactModule = require("react");
    return ReactModule.cloneElement(children, { onMockGestureStart: gesture.start,
      onMockGestureUpdate: gesture.update,
      onMockGestureEnd: (event: { translationY: number }) => {
        if (!mockHistoryDragActive.value) gesture.start();
        gesture.finalize(event, true);
      },
      onMockGestureCancel: (event: { translationY: number }) => gesture.finalize(event, false),
      onMockGestureFail: (event: { translationY: number }) => gesture.finalize(event, false),
      gestureEnabled: gesture.isEnabled, gestureVerticalRange: gesture.verticalRange,
      gestureHorizontalRange: gesture.horizontalRange });
  },
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({ runnerUrl: "http://runner.test", runnerToken: "token" }),
}));
jest.mock("../contexts/ConversationContext", () => ({
  useConversation: () => ({ logSessionDiag: mockLogSessionDiag }),
}));
jest.mock("react-native-reanimated", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    __esModule: true,
    default: { View: (props: Record<string, unknown>) => ReactModule.createElement(View, props),
      createAnimatedComponent: (Component: unknown) => Component },
    FadeIn: { duration: (duration: number) => ({ type: "fade-in", duration }) },
    FadeOut: { duration: (duration: number) => ({ type: "fade-out", duration }) },
    runOnJS: (callback: unknown) => callback,
    useSharedValue: (initial: unknown) => typeof initial === "boolean" ? mockHistoryDragActive : mockHistoryHeight,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    withTiming: (value: number, config: unknown, callback?: (finished: boolean) => void) =>
      mockWithTiming(value, config, callback),
  };
});

const playback = {
  synthesizeSpeechStream: mockSynthesizeSpeechStream,
  stopTtsPlayback: mockStopTtsPlayback,
  isTtsPlaybackActive: false,
  ttsUiStatus: "idle" as const,
};

async function render(element: ReactElement) {
  const screen = await testingRender(element);
  await waitFor(() => screen.getByTestId("voice-conversation-screen"));
  return screen;
}

function ClosableVoiceScreen() {
  const [open, setOpen] = useState(true);
  return open ? <VoiceConversationScreen {...playback} onClose={() => {
    mockOnClose();
    setOpen(false);
  }} /> : null;
}

beforeEach(() => {
  AppState.currentState = "active";
  jest.clearAllMocks();
  mockLastSttOptions = null;
  mockUseActualStreamingStt = false;
  mockNativeSttListeners.clear();
  mockFooterProps = null;
  mockFooterRenders.length = 0;
  mockOnCompleted = null;
  mockOnJob = null;
  mockMainTts = null;
  mockTurnTts = null;
  mockStt.active = false;
  mockStt.correctionPreview = null;
  mockVoice.ready = true;
  mockVoice.logicalConversationId = "conversation-one";
  mockVoice.turnStatus = "completed";
  mockVoice.reply = { text: "表示しない返答本文", operationId: "operation-1" };
  mockVoice.error = "";
  mockVoice.contextStats.contextUsagePercent = 31;
  mockVoice.history = [];
  mockVoice.historyError = "";
  mockVoice.taskChecklist = { status: "present", markdown: "# 最優先\n\n- [ ] 確認する" };
  mockVoice.taskChecklistOverview = { status: "present", markdown: "- [ ] 確認する" };
  mockVoice.taskChecklistCompletion = null;
  mockVoice.respondToChecklistCompletion.mockClear();
  mockHistoryHeight.value = 0;
  mockHistoryDragActive.value = false;
  mockReduceMotion = false;
  mockManagerVisible = false;
  mockManagerOnClose = null;
  mockGeneration = 1;
  mockHookOrchestratorIds.length = 0;
  mockQuestionHandlers.clear();
});
afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: initialPlatform });
  jest.restoreAllMocks();
});

test("main history shows read-only checklist states without a title and folds to a tab", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.queryByText("To Do")).toBeNull();
  expect(screen.queryByText("最優先")).toBeNull();
  expect(screen.getByTestId("voice-task-checklist-item-0").props.accessibilityState)
    .toMatchObject({ checked: false, disabled: true });
  expect(screen.getByText("確認する")).toBeTruthy();
  const panelStyle = StyleSheet.flatten(screen.getByTestId("voice-task-checklist-panel").props.style);
  expect(panelStyle.bottom).toBeUndefined();
  expect(panelStyle.width).toBeUndefined();
  expect(panelStyle.minWidth).toBeUndefined();
  expect(panelStyle.maxWidth).toBeLessThanOrEqual(260);
  expect(panelStyle.maxHeight).toBe("65%");
  expect(panelStyle.backgroundColor).toBeTruthy();
  expect(panelStyle.borderLeftWidth).toBeUndefined();
  expect(screen.queryByTestId("voice-task-checklist-refresh")).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-content").props.style))
    .toMatchObject({ flexGrow: 0, flexShrink: 1 });
  const longChecklist = Array.from({ length: 40 }, (_, index) => `- [${index === 0 ? "x" : " "}] 手順 ${index + 1}`).join("\n");
  mockVoice.taskChecklist = { status: "present", markdown: longChecklist };
  mockVoice.taskChecklistOverview = { status: "present", markdown: longChecklist };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-task-checklist-item-0").props.accessibilityState.checked).toBe(true);
  expect(screen.getByTestId("voice-task-checklist-item-39").props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByTestId("voice-task-checklist-collapse"));
  expect(screen.queryByTestId("voice-task-checklist-panel")).toBeNull();
  expect(screen.queryByTestId("voice-task-checklist-item-0")).toBeNull();
  expect(screen.getByTestId("voice-task-checklist-expand")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("voice-task-checklist-expand"));
  expect(screen.getByTestId("voice-task-checklist-panel")).toBeTruthy();
});

test("orchestrator voice controls generated and manual playback", async () => {
  mockMainTts = { ttsProvider: "google", voiceId: "ja-JP-Neural2-B" };
  const screen = await render(<VoiceConversationScreen {...playback} ttsSpeed={1.4} onClose={mockOnClose} />);
  expect(mockTurnTts).toEqual({ speedScale: 1.4 });
  await act(async () => { mockOnCompleted?.("返答", "voice-operation"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("返答", {
    scope: "voice", orchestratorId: "main", messageId: "voice-operation", ttsProvider: "google", voiceId: "ja-JP-Neural2-B",
  });
  await screen.unmount();
});

test("announces the orchestrator once with its voice before starting STT after playback", async () => {
  mockMainTts = { ttsProvider: "google", voiceId: "ja-JP-Neural2-B" };
  mockVoice.ready = false;
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("メインで音声入力を準備します", {
    scope: "voice", orchestratorId: "main", messageId: expect.stringMatching(/^voice-start-/u), ttsProvider: "google", voiceId: "ja-JP-Neural2-B",
  });
  expect(mockStt.start).not.toHaveBeenCalled();
  expect(mockLastSttOptions?.ttsPlaybackActive).toBe(true);
  await screen.rerender(<VoiceConversationScreen {...playback} ttsUiStatus="queued" onClose={mockOnClose} />);
  await act(async () => { finishSynthesis(); });
  expect(mockStt.start).not.toHaveBeenCalled();
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockStt.start).not.toHaveBeenCalled();
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockStt.start).toHaveBeenCalledTimes(1);

  mockVoice.ready = false;
  mockGeneration += 1;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("starts STT after a failed start announcement without retrying the announcement", async () => {
  mockSynthesizeSpeechStream.mockRejectedValueOnce(new Error("TTS unavailable"));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await waitFor(() => expect(mockStt.start).toHaveBeenCalledTimes(1));
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("waits for existing chat playback before announcing and starting the microphone", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} isTtsPlaybackActive
    ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
  expect(mockStt.start).not.toHaveBeenCalled();
  expect(mockStopTtsPlayback).not.toHaveBeenCalled();
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("メインで音声入力を準備します", expect.any(Object));
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  expect(mockStopTtsPlayback).not.toHaveBeenCalled();
  await screen.unmount();
});

test("closing during the start announcement stops only that speech and prevents a late microphone start", async () => {
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  const screen = await render(<ClosableVoiceScreen />);
  const announcementTarget = mockSynthesizeSpeechStream.mock.calls[0][1];
  expect(mockStt.start).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId("streaming-stt-stop"));
  expect(mockStopTtsPlayback).toHaveBeenCalledWith({
    interruptStream: true, reason: "voice_screen_closed", expectedMessageId: announcementTarget.messageId,
  });
  await act(async () => { finishSynthesis(); });
  expect(mockStt.start).not.toHaveBeenCalled();
  await screen.unmount();
});

test("returning from management resumes STT without repeating the start announcement", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await fireEvent(screen.getByTestId("voice-orchestrator-floating"), "longPress");
  expect(mockManagerVisible).toBe(true);
  await act(async () => { mockManagerOnClose?.(); });
  expect(mockManagerVisible).toBe(false);
  expect(mockStt.start).toHaveBeenCalledTimes(2);
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("checklist retry appears only when history or checklist loading fails", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.queryByTestId("voice-task-checklist-refresh")).toBeNull();
  mockVoice.taskChecklist = { status: "unavailable" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await fireEvent.press(screen.getByTestId("voice-task-checklist-refresh"));
  expect(mockVoice.refreshHistory).toHaveBeenCalled();
  mockVoice.taskChecklist = { status: "present", markdown: "- [ ] 確認する" };
  mockVoice.historyError = "履歴を読み込めません";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-task-checklist-refresh")).toBeTruthy();
  mockVoice.historyError = "";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.queryByTestId("voice-task-checklist-refresh")).toBeNull();
});

test("completed checklist offers one explicit archive and clear action", async () => {
  mockVoice.taskChecklist = { status: "present", markdown: "- [x] 作業完了\n" };
  mockVoice.taskChecklistOverview = { status: "present", markdown: "- [x] 作業完了" };
  mockVoice.taskChecklistCompletion = { sourceHash: "a".repeat(64), version: "b".repeat(64) };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const clear = screen.getByTestId("voice-task-checklist-clear");
  expect(clear.props.accessibilityLabel).toBe("完了した To Do を履歴に保存して空にする");
  expect(screen.getByText("trash-outline")).toBeTruthy();
  expect(screen.queryByTestId("voice-task-checklist-keep")).toBeNull();
  expect(screen.queryByText("すべて完了しました。履歴に保存して To Do を空にしますか？")).toBeNull();
  await act(async () => { fireEvent.press(clear); });
  await waitFor(() => expect(mockVoice.respondToChecklistCompletion)
    .toHaveBeenCalledWith("a".repeat(64), "b".repeat(64), "clear"));
});

test("legacy prose stays visible until the AI rewrites the source file", async () => {
  mockVoice.taskChecklist = { status: "present", markdown: "# タイトル\n\n進捗は不明\n- [ ] 要確認\n" };
  mockVoice.taskChecklistOverview = { status: "unavailable" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("概要を作成できませんでした")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("voice-task-checklist-source-toggle"));
  expect(screen.getByText("# タイトル")).toBeTruthy();
  expect(screen.getByText("進捗は不明")).toBeTruthy();
  expect(screen.getByText("要確認")).toBeTruthy();
});

test("display overview defaults to a few checked rows and switches to the unchanged original", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  mockVoice.taskChecklist = { status: "present", markdown: "# 原本\n- 確認済み\n- 次の確認は未着手\n" };
  mockVoice.taskChecklistOverview = { status: "present", markdown: "- [x] 確認済みの作業\n- [ ] 次の確認" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("確認済みの作業")).toBeTruthy();
  expect(screen.getByText("document-text-outline")).toBeTruthy();
  expect(screen.getByTestId("voice-task-checklist-source-toggle").props.accessibilityLabel)
    .toBe("To Do原本を表示");
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-source-toggle").props.style))
    .toMatchObject({ width: 44, height: 44 });
  expect(screen.getByTestId("voice-task-checklist-blur")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-tint").props.style).backgroundColor)
    .toBe("rgba(255, 255, 255, 0.42)");
  const overviewPanelStyle = StyleSheet.flatten(screen.getByTestId("voice-task-checklist-panel").props.style);
  expect(overviewPanelStyle.borderColor).toBe(VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors.borderTranslucent);
  expect(screen.getByTestId("voice-task-checklist-item-0").props.accessibilityState)
    .toMatchObject({ checked: true, disabled: true });
  expect(StyleSheet.flatten(screen.getByText("確認済みの作業").props.style).textDecorationLine)
    .toBe("line-through");
  expect(StyleSheet.flatten(screen.getByText("次の確認").props.style).textDecorationLine)
    .toBe("none");
  expect(screen.queryByText("確認済み")).toBeNull();
  await fireEvent.press(screen.getByTestId("voice-task-checklist-source-toggle"));
  expect(screen.getByText("list-outline")).toBeTruthy();
  expect(screen.getByTestId("voice-task-checklist-source-toggle").props.accessibilityLabel)
    .toBe("To Do概要を表示");
  expect(screen.getByTestId("voice-task-checklist-blur")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-tint").props.style).backgroundColor)
    .toBe("rgba(255, 255, 255, 0.42)");
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-panel").props.style).borderColor)
    .toBe(VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors.borderStrong);
  expect(screen.getByText("- 確認済み")).toBeTruthy();
  expect(screen.getByText("- 次の確認は未着手")).toBeTruthy();
  expect(screen.queryByTestId("voice-task-checklist-item-0")).toBeNull();
  await fireEvent.press(screen.getByTestId("voice-task-checklist-source-toggle"));
  expect(screen.getByTestId("voice-task-checklist-item-0").props.accessibilityState.checked).toBe(true);
});

test("overview has a translucent fallback without native blur", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.queryByTestId("voice-task-checklist-blur")).toBeNull();
  expect(screen.getByTestId("voice-task-checklist-tint")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-tint").props.style).backgroundColor)
    .toBe(VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors.surfaceTranslucent);
});

test("pending overview stays compact while the original remains available", async () => {
  mockVoice.taskChecklist = { status: "present", markdown: Array.from({ length: 25 }, (_, index) =>
    `- legacy detail ${index + 1}`).join("\n") };
  mockVoice.taskChecklistOverview = { status: "pending" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("概要を作成中…")).toBeTruthy();
  expect(screen.queryByText("- legacy detail 1")).toBeNull();
  await fireEvent.press(screen.getByTestId("voice-task-checklist-source-toggle"));
  expect(screen.getByText("- legacy detail 1")).toBeTruthy();
  expect(screen.queryByTestId("voice-task-checklist-item-0")).toBeNull();
});

test("older Runner without an overview field still shows its original checklist", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  mockVoice.taskChecklist = { status: "present", markdown: "- [ ] 旧Runnerの作業\n" };
  mockVoice.taskChecklistOverview = null;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("旧Runnerの作業")).toBeTruthy();
  expect(screen.queryByTestId("voice-task-checklist-source-toggle")).toBeNull();
  expect(screen.getByTestId("voice-task-checklist-blur")).toBeTruthy();
  expect(screen.getByTestId("voice-task-checklist-tint")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId("voice-task-checklist-panel").props.style))
    .toMatchObject({ backgroundColor: "transparent",
      borderColor: VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors.borderStrong });
});

test("task checklist states are distinct and every orchestrator has its own panel", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  mockVoice.taskChecklist = { status: "missing" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByText("To Doはまだ作成されていません")).toBeTruthy();
  mockVoice.taskChecklist = { status: "unavailable" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByText("To Doを読み込めませんでした")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("voice-orchestrator-other"));
  await waitFor(() => expect(mockHookOrchestratorIds.at(-1)).toBe("other"));
  expect(screen.getByTestId("voice-task-checklist-panel")).toBeTruthy();
  expect(screen.getByText("To Doを読み込めませんでした")).toBeTruthy();
});

test("notification target wins an in-flight list, opens history, and stays selected after reconnect", async () => {
  let resolveList!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise((resolve) => {
    resolveList = resolve as (value: unknown) => void;
  }));
  mockVoice.history = [{ role: "assistant", text: "visible reply", clientOperationId: "operation-1",
    completedOrdinal: 1 }];
  const screen = await testingRender(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  await waitFor(() => expect(mockQuestionHandlers.has("voice.unread.changed")).toBe(true));
  await act(async () => mockQuestionHandlers.get("voice.unread.changed")?.forEach((listener) => listener({ channel: "agent",
    op: "voice.unread.changed", payload: { orchestrators: [
      { id: "main", name: "メイン", icon: "", unreadCount: 0 },
      { id: "other", name: "調査", icon: "", unreadCount: 1 },
    ], selectedId: "main" } })));
  expect(screen.getByTestId("voice-conversation-history")).toBeTruthy();
  expect(screen.getByTestId("voice-orchestrator-unread-other")).toBeTruthy();
  expect(mockHookOrchestratorIds.at(-1)).toBe("other");
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.read", payload: expect.objectContaining({ orchestratorId: "other", completedOrdinal: 1 }),
  })));
  await act(async () => resolveList({ op: "voice.orchestrators.list.result", payload: {
    orchestrators: [{ id: "main", name: "メイン", icon: "" }, { id: "other", name: "調査", icon: "" }],
    selectedId: "main",
  } }));
  expect(mockHookOrchestratorIds.at(-1)).toBe("other");
  await act(async () => fireEvent.press(screen.getByTestId("voice-orchestrator-main")));
  expect(mockHookOrchestratorIds.at(-1)).toBe("main");
  mockGeneration = 2;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  expect(mockHookOrchestratorIds.at(-1)).toBe("main");
});

test("a removed explicit target does not start recording in another orchestrator", async () => {
  const screen = await testingRender(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="removed" />);
  await waitFor(() => expect(screen.getByText("指定したオーケストレータが見つかりません。")).toBeTruthy());
  expect(mockHookOrchestratorIds).toHaveLength(0);
});

test("an explicit target removed after loading does not switch to the default orchestrator", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  expect(mockHookOrchestratorIds.at(-1)).toBe("other");
  const sessionCount = mockHookOrchestratorIds.length;
  await waitFor(() => expect(mockQuestionHandlers.has("voice.unread.changed")).toBe(true));
  await act(async () => mockQuestionHandlers.get("voice.unread.changed")?.forEach((listener) => listener({ channel: "agent",
    op: "voice.unread.changed", payload: {
      orchestrators: [{ id: "main", name: "メイン", icon: "" }], selectedId: "main",
    } })));
  expect(screen.getByText("指定したオーケストレータが見つかりません。")).toBeTruthy();
  expect(mockHookOrchestratorIds).toHaveLength(sessionCount);
});

test("history header shares the context indicator without exposing chat session actions", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="main" />);
  const history = within(screen.getByTestId("voice-conversation-history"));
  expect(history.getByLabelText("コンテキスト使用量 31%")).toBeTruthy();
  expect(history.queryByRole("button", { name: "コンテキスト使用量 31%" })).toBeNull();
  expect(screen.queryByText("同じディレクトリーで新規セッション")).toBeNull();
  mockVoice.contextStats.contextUsagePercent = null;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="main" />);
  expect(history.getByLabelText("コンテキスト使用量 --")).toBeTruthy();
  expect(history.queryByText("--%")).toBeNull();
});

test("inactive voice history does not mark a reply read", async () => {
  AppState.currentState = "inactive";
  mockVoice.history = [{ role: "assistant", text: "unseen reply", clientOperationId: "operation-1",
    completedOrdinal: 1 }];
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  expect(screen.getByTestId("voice-conversation-history")).toBeTruthy();
  expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ op: "voice.read" }));
});

test("active collapsed voice reply is read without opening history", async () => {
  mockVoice.reply = { text: "届いた返答", operationId: "operation-1", completedOrdinal: 3 };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.queryByTestId("voice-conversation-history")).toBeNull();
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.read", payload: { orchestratorId: "main", logicalConversationId: "conversation-one",
      completedOrdinal: 3 },
  })));
});

test("inactive collapsed voice reply stays unread", async () => {
  AppState.currentState = "inactive";
  mockVoice.reply = { text: "届いた返答", operationId: "operation-1", completedOrdinal: 3 };
  await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockRequest).not.toHaveBeenCalledWith(expect.objectContaining({ op: "voice.read" }));
});

test("the orchestrator renders the shared question form and submits its selected answer", async () => {
  const previousState = AppState.currentState;
  AppState.currentState = "active";
  try {
    const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
    await act(async () => mockQuestionHandlers.get("voice.userInput.request")?.forEach((listener) => listener({
      channel: "agent", op: "voice.userInput.request", operationId: "operation-question",
      payload: { requestId: "q1", orchestratorId: "main", threadId: "native-thread", startedAtMs: Date.now(),
        params: { questions: [{ id: "choice", header: "選択", question: "どちらですか？", isOther: false, isSecret: false,
          options: [{ label: "A", description: "最初" }, { label: "B", description: "次" }] }] } },
    })));
    expect(screen.getByText("どちらですか？")).toBeTruthy();
    await fireEvent.press(screen.getByText("B"));
    await fireEvent.press(screen.getByText("回答する"));
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      op: "voice.userInput.respond", operationId: "operation-question",
      payload: { requestId: "q1", result: { answers: { choice: { answers: ["B"] } } } },
    }), { timeoutMs: 30_000 });
    await screen.unmount();
  } finally { AppState.currentState = previousState; }
});

test("the footer reveals stored messages and closes the history panel", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  mockVoice.reply = { text: "表示しない返答本文", operationId: "operation-1", outputTokens: 24 };
  mockVoice.history = [
    { role: "user", text: "最初の質問", clientOperationId: "one", at: "2026-09-27T12:34:00" },
    { role: "assistant", text: "最初の返答", clientOperationId: "one", at: "2026-09-27T12:35:00" },
  ];
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  const backdrop = screen.getByTestId("voice-conversation-backdrop");
  expect(screen.getByTestId("voice-conversation-keyboard-avoiding").children[0]).toBe(backdrop);
  expect(StyleSheet.flatten(backdrop.props.style)).toMatchObject({
    position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  });
  expect(backdrop.props.pointerEvents).toBe("none");
  expect(mockWithTiming).toHaveBeenCalledWith(0, { duration: 240 }, expect.any(Function));
  expect(screen.queryByTestId("voice-history-open")).toBeNull();
  expect(screen.getByTestId("voice-history-swipe-area").props).toMatchObject({
    gestureVerticalRange: [-24, 24], gestureHorizontalRange: [-32, 32],
  });
  expect(within(screen.getByTestId("voice-history-swipe-area")).getByTestId("voice-orchestrator-floating")).toBeTruthy();
  expect(within(screen.getByTestId("streaming-stt-trailing-accessory"))
    .getByTestId("codex-status-summary-menu")).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId("voice-footer-inset").props.style))
    .toMatchObject({ paddingLeft: 12, paddingRight: 20 });
  expect(StyleSheet.flatten(screen.getByTestId("voice-orchestrator-floating").props.style))
    .toMatchObject({ width: 44, height: 44 });
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(StyleSheet.flatten(screen.getByTestId("voice-footer-inset").props.style).paddingLeft).toBe(20);
  expect(mockWithTiming).toHaveBeenCalledWith(expect.any(Number), { duration: 240 }, expect.any(Function));
  expect(mockHistoryHeight.value).toBeGreaterThan(0);
  expect(screen.getByTestId("voice-conversation-backdrop").props.pointerEvents).toBe("auto");
  const blur = screen.getByTestId("voice-conversation-board-blur");
  expect(screen.getByTestId("voice-conversation-keyboard-avoiding").children[0]).toBe(blur.parent);
  expect(blur.props).toMatchObject({ pointerEvents: "none", intensity: 80, tint: "dark" });
  expect(StyleSheet.flatten(blur.props.style)).toMatchObject({
    position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
  });
  expect(StyleSheet.flatten(blur.props.style).opacity).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-history").props.style))
    .toMatchObject({ flexShrink: 1, width: "100%", overflow: "hidden" });
  expect(StyleSheet.flatten(screen.getByTestId("voice-history-messages").props.style)).toMatchObject({ flex: 1 });
  expect(screen.getByTestId("voice-history-messages").props.contentContainerStyle).toMatchObject({
    paddingHorizontal: 20, paddingBottom: 12,
  });
  expect(screen.getByTestId("voice-history-close").props).toMatchObject({
    accessibilityRole: "button", accessibilityLabel: "履歴を閉じる",
  });
  expect(StyleSheet.flatten(screen.getByTestId("voice-history-close").props.style)).toMatchObject({
    width: 44, height: 44,
  });
  expect(screen.getByText("close")).toBeTruthy();
  expect(screen.queryByText("閉じる")).toBeNull();
  expect(screen.queryByTestId("voice-history-handle")).toBeNull();
  expect(screen.getByText("最初の質問")).toBeTruthy();
  expect(screen.getByText("最初の返答")).toBeTruthy();
  expect(screen.queryByTestId("voice-history-account-menu")).toBeNull();
  expect(within(screen.getByTestId("streaming-stt-trailing-accessory"))
    .getByTestId("codex-status-summary-menu")).toBeTruthy();
  expect(screen.getByText("total 24 tok")).toBeTruthy();
  expect(screen.getByText("09/27 12:34")).toBeTruthy();
  expect(screen.getByText("09/27 12:35")).toBeTruthy();
  expect(screen.queryByText(/-- tok/)).toBeNull();
  const colors = VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors;
  expect(StyleSheet.flatten(screen.getByText("最初の質問").parent?.props.style).backgroundColor).toBe(colors.accent);
  expect(StyleSheet.flatten(screen.getByText("最初の返答").parent?.props.style).backgroundColor).toBe(colors.surfaceMuted);
  expect(screen.getByText("最初の質問").props.style.color).toBe(colors.textOnAccent);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: 80 }); });
  expect(screen.getByText("最初の質問")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("voice-history-close")); });
  expect(mockWithTiming).toHaveBeenLastCalledWith(0, { duration: 240 }, expect.any(Function));
  expect(screen.getByTestId("voice-conversation-backdrop").props.pointerEvents).toBe("none");
  expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
  expect(screen.queryByText("最初の質問")).toBeNull();
  expect(within(screen.getByTestId("streaming-stt-trailing-accessory"))
    .getByTestId("codex-status-summary-menu")).toBeTruthy();
  await screen.unmount();
});

test("slow upward dragging reveals history and backdrop in step with the finger", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  mockWithTiming.mockClear();
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureStart(); });
  expect(screen.getByTestId("voice-conversation-history", { includeHiddenElements: true }).props.pointerEvents)
    .toBe("none");
  expect(mockFooterProps?.historyExpanded).toBe(false);
  expect(screen.getByTestId("voice-conversation-backdrop").props.pointerEvents).toBe("none");

  for (const distance of [28, 40, 65]) {
    await act(async () => {
      screen.getByTestId("voice-history-swipe-area").props.onMockGestureUpdate({ translationY: -distance });
    });
    await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
    expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-history",
      { includeHiddenElements: true }).props.style).height).toBe(distance);
    expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-backdrop").props.style).opacity)
      .toBeCloseTo(distance / 240);
  }
  expect(mockWithTiming).not.toHaveBeenCalled();
  await act(async () => {
    screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -65 });
  });
  expect(mockFooterProps?.historyExpanded).toBe(true);
  expect(screen.getByTestId("voice-conversation-history").props.pointerEvents).toBe("auto");
  expect(mockHistoryHeight.value).toBeGreaterThan(65);
  await screen.unmount();
});

test("an interrupted or short drag settles closed without activating history", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  mockWithTiming.mockClear();
  await act(async () => {
    screen.getByTestId("voice-history-swipe-area").props.onMockGestureFail({ translationY: 0 });
  });
  expect(screen.queryByTestId("voice-conversation-history")).toBeNull();
  expect(mockWithTiming).not.toHaveBeenCalled();
  for (const finish of ["onMockGestureCancel", "onMockGestureEnd"] as const) {
    await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureStart(); });
    await act(async () => {
      screen.getByTestId("voice-history-swipe-area").props.onMockGestureUpdate({ translationY: -40 });
    });
    await act(async () => {
      screen.getByTestId("voice-history-swipe-area").props[finish]({ translationY: -40 });
    });
    expect(screen.queryByTestId("voice-conversation-history")).toBeNull();
    expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
    expect(mockFooterProps?.historyExpanded).toBe(false);
    expect(mockHistoryHeight.value).toBe(0);
  }
  await screen.unmount();
});

test("shows the in-flight assistant reply in history and replaces it with the stored message", async () => {
  mockVoice.history = [{ role: "user", text: "質問", clientOperationId: "live-operation" }];
  mockVoice.reply = { text: "生成途中", operationId: "live-operation" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("生成途中")).toBeTruthy();

  mockVoice.reply = { text: "確定した返答", operationId: "live-operation" };
  mockVoice.history = [
    { role: "user", text: "質問", clientOperationId: "live-operation" },
    { role: "assistant", text: "確定した返答", clientOperationId: "live-operation" },
  ];
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getAllByText("確定した返答")).toHaveLength(1);
  await screen.unmount();
});

test("macOS renders the native within-window blur behind the dark overlay", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "macos" });
  const nativeViewSpy = jest.spyOn(require("react-native"), "requireNativeComponent");
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const blur = screen.getByTestId("voice-conversation-board-blur");
  expect(blur.type).toBe("BittyVoiceBlur");
  expect(blur.props.pointerEvents).toBe("none");
  expect(screen.getByTestId("voice-task-checklist-blur").type).toBe("BittyVoiceBlur");
  expect(StyleSheet.flatten(blur.props.style).opacity).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-backdrop").props.style).backgroundColor)
    .toBe("rgba(0, 0, 0, 0.4)");
  await act(async () => { fireEvent.press(screen.getByTestId("voice-history-close")); });
  expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
  await screen.unmount();
  const remounted = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { remounted.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(nativeViewSpy.mock.calls.filter(([name]) => name === "BittyVoiceBlur")).toHaveLength(1);
  await remounted.unmount();
});

test("Android keeps the dark fallback without loading native blur", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-backdrop").props.style).backgroundColor)
    .toBe("rgba(0, 0, 0, 0.68)");
  await screen.unmount();
});

test("history omits timestamps that are missing or invalid", async () => {
  mockVoice.history = [
    { role: "user", text: "時刻なし", clientOperationId: "one" },
    { role: "assistant", text: "不正な時刻", clientOperationId: "one", at: "not-a-date" },
  ];
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(screen.getByText("時刻なし")).toBeTruthy();
  expect(screen.getByText("不正な時刻")).toBeTruthy();
  expect(screen.queryAllByText(/\d{2}\/\d{2} \d{2}:\d{2}/)).toHaveLength(0);
  await screen.unmount();
});

test("reduced motion skips history movement and backdrop transition", async () => {
  mockReduceMotion = true;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(mockWithTiming).toHaveBeenLastCalledWith(expect.any(Number), { duration: 0 }, expect.any(Function));
  expect(screen.getByTestId("voice-conversation-history").props.entering).toBeUndefined();
  expect(screen.getByTestId("voice-conversation-history").props.exiting).toBeUndefined();
  await screen.unmount();
});

test("the existing footer exposes history control and leaves editing gestures alone", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-history-swipe-area").props.gestureEnabled).toBe(true);
  await act(async () => { mockFooterProps?.onHistoryToggle?.(); });
  expect(screen.getByTestId("voice-conversation-history")).toBeTruthy();
  expect(mockFooterProps?.historyExpanded).toBe(true);
  await act(async () => { mockFooterProps?.onFocus?.(); });
  expect(screen.getByTestId("voice-history-swipe-area").props.gestureEnabled).toBe(false);
  await act(async () => { mockFooterProps?.onBlur?.(); });
  expect(screen.getByTestId("voice-history-swipe-area").props.gestureEnabled).toBe(true);
  await screen.unmount();
});

test("an open history panel waits for the hook to validate its conversation", async () => {
  mockVoice.ready = false;
  mockVoice.turnStatus = "idle";
  mockVoice.history = [{ role: "user", text: "前の接続先の発話", clientOperationId: "old" }];
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(mockVoice.refreshHistory).not.toHaveBeenCalled();
  expect(screen.getByText("履歴を読み込み中…")).toBeTruthy();
  expect(screen.queryByText("前の接続先の発話")).toBeNull();
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByText("前の接続先の発話")).toBeTruthy();
  mockVoice.history = [];
  mockVoice.reply = { text: "", operationId: "" };
  mockVoice.logicalConversationId = "conversation-two";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.queryByText("前の接続先の発話")).toBeNull();
  expect(screen.getByText("履歴はまだありません")).toBeTruthy();
  await screen.unmount();
});

test("new history content keeps the position while older messages are being read", async () => {
  const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => undefined);
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const history = screen.getByTestId("voice-history-messages");
  expect(history.props.onContentSizeChange).toBeUndefined();
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 80 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  mockVoice.history = [{ role: "user", text: "追加の質問", clientOperationId: "operation-2" }];
  mockVoice.reply = { text: "新しい返答", operationId: "operation-2" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  mockVoice.logicalConversationId = "conversation-two";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(2);
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 500 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  mockVoice.reply = { text: "更新中の返答", operationId: "operation-2" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(3);
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(3);
  await act(async () => { fireEvent.press(screen.getByTestId("voice-history-close")); });
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(scrollToEnd).toHaveBeenCalledTimes(4);
  scrollToEnd.mockRestore();
  await screen.unmount();
});

test("expanding learning details and loading their metadata keep the message anchored at the tail", async () => {
  const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => undefined);
  const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo").mockImplementation(() => undefined);
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  let finishDelivery!: () => void;
  mockRequest.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { finishDelivery = resolve; });
    return { op: "voice.learning.delivery.result",
      payload: { delivery: { items: [], reads: [], inheritedReads: [], readsVerified: true } } };
  });
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const history = screen.getByTestId("voice-history-messages");
  expect(history.props.onContentSizeChange).toBeUndefined();
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 500 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  mockVoice.reply = { ...mockVoice.reply, text: "同じ高さの返答本文" };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(2);
  expect(history.props.onContentSizeChange).toBeUndefined();
  await fireEvent.press(screen.getByRole("button", { name: /^回答の学習・参照詳細/ }));
  expect(screen.getByText("参照記録を確認中…")).toBeTruthy();
  expect(scrollToEnd).toHaveBeenCalledTimes(2);
  await act(async () => { finishDelivery(); });
  expect(screen.getByText("0件の知識・スキル · 重複を除く")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: /^回答の学習・参照詳細/ }));
  expect(scrollToEnd).toHaveBeenCalledTimes(2);
  expect(scrollTo).not.toHaveBeenCalled();
  scrollToEnd.mockRestore();
  scrollTo.mockRestore();
  await screen.unmount();
});

test("hidden and loading history wait until a visible ready history can follow its content", async () => {
  const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => undefined);
  mockVoice.ready = false;
  mockVoice.reply = { text: "", operationId: "" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).not.toHaveBeenCalled();
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(screen.getByTestId("voice-history-messages").props.onContentSizeChange).toBeUndefined();
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  scrollToEnd.mockRestore();
  await screen.unmount();
});

test("history scrolling and downward swipes do not dismiss the panel", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const history = screen.getByTestId("voice-history-messages");
  const panel = screen.getByTestId("voice-conversation-history");
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 80 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 0 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: 80 }); });
  expect(screen.getByTestId("voice-conversation-history")).toBe(panel);
  expect(panel.props.onMockPanelRelease).toBeUndefined();
  await screen.unmount();
});

test("routes privacy-safe STT diagnostics from the voice conversation to the shared log", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  mockLastSttOptions?.onDiagnostic("stt_final_transcript_received", { version: 1, chars: 0, lastPartialChars: 7 });
  expect(mockLogSessionDiag).toHaveBeenCalledWith("stt_final_transcript_received", {
    source: "voice_conversation", version: 1, chars: 0, lastPartialChars: 7,
    paused: false, transitioning: false, ready: true, replyLoading: false, turnStatus: "completed", playbackActive: false,
  }, { throttleMs: 0 });
  expect(JSON.stringify(mockLogSessionDiag.mock.calls)).not.toContain("runner.test");
  await screen.unmount();
});

test("shows only the shared footer immediately and starts recording once voice.open is ready", async () => {
  mockVoice.ready = false;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);

  expect(screen.getByTestId("streaming-stt-footer")).toBeTruthy();
  expect(mockFooterProps?.transcript).toBe("録音を準備しています…");
  expect(mockFooterProps?.voiceContextStats).toEqual(mockVoice.contextStats);
  expect(screen.queryByText("音声会話")).toBeNull();
  expect(screen.queryByText("返答を再生")).toBeNull();
  expect(screen.queryByTestId("voice-conversation-microphone")).toBeNull();
  expect(screen.getByTestId("voice-conversation-transition").props).toMatchObject({
    entering: { type: "fade-in", duration: 220 },
    exiting: { type: "fade-out", duration: 220 },
  });
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-transition").props.style)).toMatchObject({
    flex: 1, width: "100%",
  });
  expect(screen.getByTestId("voice-conversation-transition").props.pointerEvents).toBe("box-none");
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-keyboard-avoiding").props.style)).toMatchObject({
    position: "absolute", top: 0, bottom: 0, justifyContent: "flex-end",
  });
  expect(screen.getByTestId("voice-conversation-keyboard-avoiding").props.behavior).toBe("padding");
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-screen").props.style)).toMatchObject({ flex: 1 });
  expect(screen.getByTestId("voice-conversation-screen").props.pointerEvents).toBe("box-none");
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-content").props.style)).toMatchObject({
    flex: 1, justifyContent: "flex-end",
  });
  expect(screen.getByTestId("voice-conversation-content").props.pointerEvents).toBe("box-none");
  expect(mockStt.start).not.toHaveBeenCalled();

  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("stopping before voice.open is ready closes the footer and prevents recording", async () => {
  mockVoice.ready = false;
  const screen = await render(<ClosableVoiceScreen />);
  await fireEvent.press(screen.getByTestId("streaming-stt-stop"));

  expect(mockAbort).toHaveBeenCalled();
  expect(mockOnClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("streaming-stt-footer")).toBeNull();
  expect(screen.queryByTestId("voice-conversation-transition")).toBeNull();
  expect(mockAbort).toHaveBeenCalled();
  expect(mockStopTtsPlayback).not.toHaveBeenCalled();

  mockVoice.ready = true;
  await screen.rerender(<ClosableVoiceScreen />);
  expect(mockStt.start).not.toHaveBeenCalled();
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
});

test("stopping active recording closes the footer immediately", async () => {
  mockStt.active = true;
  const screen = await render(<ClosableVoiceScreen />);
  await fireEvent.press(screen.getByTestId("streaming-stt-stop"));

  expect(mockAbort).toHaveBeenCalled();
  expect(mockVoice.interrupt).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("streaming-stt-footer")).toBeNull();
  expect(mockAbort).toHaveBeenCalled();
});

test("editing before voice is ready prevents late auto-start and sends only the typed draft", async () => {
  mockVoice.ready = false;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockFooterProps?.onFocus?.(); });
  expect(mockAbort).toHaveBeenCalled();
  await act(async () => { mockFooterProps?.onChangeText?.("typed draft"); });
  expect(mockFooterProps?.draftTranscript).toBe("typed draft");
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockStt.start).not.toHaveBeenCalled();
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
  await act(async () => { await mockFooterProps?.onSubmit?.("typed draft", () => true); });
  expect(mockStt.sendManualTranscript).toHaveBeenCalledWith("typed draft", expect.any(Function));
  await screen.unmount();
});

test("routes inline correction editing through the shared STT hook", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => {
    mockFooterProps?.onEditCorrection?.();
    mockFooterProps?.onChangeCorrectionText?.("編集した文章");
    mockFooterProps?.onDiscardCorrection?.();
  });
  expect(mockStt.beginCorrectionEdit).toHaveBeenCalledTimes(1);
  expect(mockStt.setCorrectionText).toHaveBeenCalledWith("編集した文章");
  expect(mockStt.discardCorrection).toHaveBeenCalledTimes(1);
  mockStt.correctionPreview = { editing: true, text: "編集した文章", deadlineMs: null,
    parts: [{ kind: "same", text: "編集した文章" }] };
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-history-swipe-area").props.gestureEnabled).toBe(false);
  await screen.unmount();
});

test("keeps the typed draft and shows a send error before voice.open is ready", async () => {
  mockVoice.ready = false;
  mockStt.sendManualTranscript.mockRejectedValueOnce(new Error("音声会話を送信できません。"));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockFooterProps?.onFocus?.(); });
  await act(async () => { mockFooterProps?.onChangeText?.("typed draft"); });
  const onAccepted = jest.fn(() => true);

  await act(async () => { await mockFooterProps?.onSubmit?.("typed draft", onAccepted); });

  expect(onAccepted).not.toHaveBeenCalled();
  expect(mockVoice.setError).toHaveBeenCalledWith("音声会話を送信できません。");
  expect(mockFooterProps?.draftTranscript).toBe("typed draft");
  mockVoice.error = "音声会話を送信できません。";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.statusText).toBe("音声会話を送信できません。");
  expect(mockFooterProps?.draftTranscript).toBe("typed draft");
  await screen.unmount();
});

test("shows connection errors inside the shared footer", async () => {
  mockVoice.ready = false;
  mockVoice.error = "音声会話を開始できません。";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);

  expect(mockFooterProps?.transcript).toBe("音声会話を開始できません。");
  expect(screen.getByTestId("streaming-stt-footer")).toBeTruthy();
  expect(mockStt.start).not.toHaveBeenCalled();
  await screen.unmount();
});

test("changes the status characters for responding and speaking, and stops for reduced motion", async () => {
  jest.useFakeTimers();
  mockVoice.turnStatus = "running";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.transcript).toBe("r");
  expect(mockFooterProps?.voiceStatus).toBe("responding");
  expect(mockFooterProps?.reduceMotion).toBe(false);
  await act(async () => { jest.advanceTimersByTime(179); });
  expect(mockFooterProps?.transcript).toBe("r");
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(mockFooterProps?.transcript).toBe("re");
  await act(async () => { jest.advanceTimersByTime(180 * 8); });
  expect(mockFooterProps?.transcript).toBe("responding");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("responding.");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("responding..");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("responding...");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("r");

  mockReduceMotion = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.reduceMotion).toBe(true);
  expect(mockFooterProps?.transcript).toBe("responding...");
  await act(async () => { jest.advanceTimersByTime(900); });
  expect(mockFooterProps?.transcript).toBe("responding...");

  mockReduceMotion = null;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.reduceMotion).toBe(true);
  expect(mockFooterProps?.transcript).toBe("r");

  mockVoice.error = "返答に失敗しました。";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.transcript).toBe("返答に失敗しました。");
  expect(mockFooterProps?.voiceStatus).toBeUndefined();

  mockVoice.error = "";
  mockVoice.turnStatus = "completed";
  mockReduceMotion = false;
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockFooterProps?.transcript).toBe("s");
  expect(mockFooterProps?.voiceStatus).toBe("speaking");
  await act(async () => { jest.advanceTimersByTime(180 * 10); });
  expect(mockFooterProps?.transcript).toBe("speaking...");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("s");
  await screen.unmount();
  jest.useRealTimers();
});

test("holds the first character until the reduced motion setting resolves", async () => {
  jest.useFakeTimers();
  mockReduceMotion = null;
  mockVoice.turnStatus = "running";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.transcript).toBe("r");
  await act(async () => { jest.advanceTimersByTime(900); });
  expect(mockFooterProps?.transcript).toBe("r");

  mockFooterRenders.length = 0;
  mockReduceMotion = false;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterRenders.every(({ transcript }) => transcript === "r")).toBe(true);
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.transcript).toBe("re");

  await screen.unmount();
  jest.useRealTimers();
});

test("starts each new voice phase at its first character even before effects reset the timer", async () => {
  jest.useFakeTimers();
  mockVoice.turnStatus = "running";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { jest.advanceTimersByTime(180 * 9); });
  expect(mockFooterProps?.transcript).toBe("responding");

  mockFooterRenders.length = 0;
  mockVoice.turnStatus = "completed";
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockFooterRenders[0]).toEqual({ transcript: "s", voiceStatus: "speaking" });

  await act(async () => { jest.advanceTimersByTime(180 * 4); });
  expect(mockFooterProps?.transcript).toBe("speak");
  mockFooterRenders.length = 0;
  mockVoice.turnStatus = "running";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterRenders[0]).toEqual({ transcript: "r", voiceStatus: "responding" });

  await screen.unmount();
  jest.useRealTimers();
});

test("keeps the speaking animation across streamed chunk gaps", async () => {
  jest.useFakeTimers();
  mockVoice.turnStatus = "running";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive isTtsPlaying ttsUiStatus="playing" onClose={mockOnClose} />);
  await act(async () => { jest.advanceTimersByTime(180 * 5); });
  expect(mockFooterProps?.statusText).toBe("speaki");

  await screen.rerender(<VoiceConversationScreen {...playback} ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockFooterProps?.voiceStatus).toBe("speaking");
  expect(mockFooterProps?.statusText).toBe("speaki");
  await act(async () => { jest.advanceTimersByTime(180); });
  expect(mockFooterProps?.statusText).toBe("speakin");

  mockVoice.turnStatus = "completed";
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockFooterProps?.statusText).toBe("speakin");
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockFooterProps?.voiceStatus).toBeUndefined();

  await screen.unmount();
  jest.useRealTimers();
});

test("plays completed replies automatically and keeps STT paused while TTS is queued", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  expect(screen.queryByText("表示しない返答本文")).toBeNull();
  expect(screen.queryByTestId("voice-conversation-replay")).toBeNull();

  await act(async () => { mockOnCompleted?.("返答", "operation-1"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("返答", { scope: "voice", orchestratorId: "main", messageId: "operation-1",
    ttsProvider: "aivisspeech", voiceId: "" });
  await screen.rerender(<VoiceConversationScreen {...playback} ttsUiStatus="queued" onClose={mockOnClose} />);
  expect(mockLastSttOptions?.ttsPlaybackActive).toBe(true);
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(mockLastSttOptions?.ttsPlaybackActive).toBe(true);
  await act(async () => { finishSynthesis(); });
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockLastSttOptions?.ttsPlaybackActive).toBe(false);
  await screen.unmount();
});

test("attaches voice playback before completion and shows speaking during generation", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  await act(async () => { mockOnJob?.("voice-job", "operation-1"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("", { scope: "voice", orchestratorId: "main", messageId: "operation-1", jobId: "voice-job",
    ttsProvider: "aivisspeech", voiceId: "" });
  expect(mockLastSttOptions?.ttsPlaybackActive).toBe(true);
  mockVoice.turnStatus = "running";
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive isTtsPlaying ttsUiStatus="queued" onClose={mockOnClose} />);
  expect(mockFooterRenders.at(-1)?.voiceStatus).toBe("speaking");
  await act(async () => { finishSynthesis(); });
  await screen.unmount();
  expect(mockStopTtsPlayback).toHaveBeenCalledWith(expect.objectContaining({
    expectedMessageId: "operation-1",
  }));
});

test("tapping while speaking cancels playback without closing or interrupting the voice turn", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockOnJob?.("voice-job", "voice-operation-1"); });
  await screen.rerender(<VoiceConversationScreen {...playback} isTtsPlaybackActive isTtsPlaying
    ttsUiStatus="playing" onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-history-swipe-area").props.gestureEnabled).toBe(true);
  await act(async () => {
    screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 });
  });
  expect(screen.getByTestId("voice-conversation-history")).toBeTruthy();

  await act(async () => { mockFooterProps?.onCancelSpeaking?.(); });

  expect(mockStopTtsPlayback).toHaveBeenCalledWith({
    interruptStream: true,
    reason: "voice_speaking_tapped",
    expectedMessageId: "voice-operation-1",
  });
  expect(mockVoice.interrupt).not.toHaveBeenCalled();
  expect(mockOnClose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("closing over active chat playback does not stop TTS without a voice reply", async () => {
  const screen = await render(<VoiceConversationScreen
    {...playback}
    isTtsPlaybackActive
    ttsUiStatus="playing"
    onClose={mockOnClose}
  />);
  await screen.unmount();

  expect(mockStopTtsPlayback).not.toHaveBeenCalled();
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
});

test("closing after a voice reply requests a stop scoped to that reply", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockOnCompleted?.("返答", "voice-operation-1"); });
  await screen.unmount();

  expect(mockStopTtsPlayback).toHaveBeenCalledTimes(1);
  expect(mockStopTtsPlayback).toHaveBeenCalledWith({
    interruptStream: true,
    reason: "voice_screen_closed",
    expectedMessageId: "voice-operation-1",
  });
});

test("switching keeps history open and stops the old recording before selecting the new orchestrator", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.getByTestId("voice-orchestrator-floating")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("voice-orchestrator-floating")); });
  expect(screen.getByTestId("voice-orchestrator-strip")).toBeTruthy();
  const oldReply = mockOnCompleted;
  await act(async () => { fireEvent.press(screen.getByTestId("voice-orchestrator-other")); });
  expect(mockAbort).toHaveBeenCalled();
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.select",
    payload: { orchestratorId: "other" } });
  expect(mockHookOrchestratorIds).toContain("other");
  expect(screen.getByTestId("voice-orchestrator-strip")).toBeTruthy();
  await act(async () => { oldReply?.("late old reply", "old-operation"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(2);
  expect(mockSynthesizeSpeechStream).toHaveBeenLastCalledWith("調査で音声入力を準備します", {
    scope: "voice", orchestratorId: "other", messageId: expect.stringMatching(/^voice-start-/u), ttsProvider: "aivisspeech", voiceId: "",
  });
  await screen.unmount();
});

test("long press on empty strip space and right click open management after stopping STT", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { fireEvent.press(screen.getByTestId("voice-orchestrator-floating")); });
  await act(async () => { fireEvent(screen.getByTestId("voice-orchestrator-strip"), "longPress"); });
  expect(mockAbort).toHaveBeenCalled();
  expect(mockManagerVisible).toBe(true);
  await screen.unmount();
  mockManagerVisible = false;
  const iconLongPress = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { fireEvent.press(iconLongPress.getByTestId("voice-orchestrator-floating")); });
  await act(async () => { fireEvent(iconLongPress.getByTestId("voice-orchestrator-other"), "longPress"); });
  expect(mockManagerVisible).toBe(true);
  expect(mockRequest.mock.calls.filter(([message]) => message.op === "voice.orchestrators.select")).toHaveLength(0);
  await iconLongPress.unmount();
  const rightClick = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { fireEvent.press(rightClick.getByTestId("voice-orchestrator-floating")); });
  await act(async () => {
    fireEvent(rightClick.getByTestId("voice-orchestrator-strip"), "pointerDown", { nativeEvent: { button: 2 } });
  });
  expect(mockManagerVisible).toBe(true);
  await rightClick.unmount();
});

test("a reply arriving while audio is being stopped cannot start speech in the next orchestrator", async () => {
  let finishAbort: (() => void) | undefined;
  mockAbort.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishAbort = () => resolve(undefined); }));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { fireEvent.press(screen.getByTestId("voice-orchestrator-floating")); });
  const oldReply = mockOnCompleted;
  await act(async () => { fireEvent.press(screen.getByTestId("voice-orchestrator-other")); });
  await act(async () => { oldReply?.("late reply", "old-operation"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledTimes(1);
  await act(async () => { finishAbort?.(); });
  await waitFor(() => expect(mockHookOrchestratorIds).toContain("other"));
  await screen.unmount();
});

test("a failed orchestrator list leaves a close control", async () => {
  mockRequest.mockRejectedValueOnce(new Error("Runner unavailable"));
  const screen = await testingRender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await waitFor(() => screen.getByText("Runner unavailable"));
  await fireEvent.press(screen.getByLabelText("音声会話を閉じる"));
  expect(mockOnClose).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("records gate changes only while connecting and without repeating unchanged gates", async () => {
  mockStt.phase = "connecting";
  mockVoice.ready = false;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  const gateCalls = () => mockLogSessionDiag.mock.calls.filter(([event]) => event === "stt_start_gate_changed");
  expect(gateCalls()).toHaveLength(1);
  expect(gateCalls()[0][1]).toEqual({ source: "voice_conversation", paused: false, transitioning: false,
    ready: false, replyLoading: false, turnStatus: "completed", playbackActive: false });
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(gateCalls()).toHaveLength(1);
  mockVoice.turnStatus = "running";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(gateCalls()).toHaveLength(2);
  expect(gateCalls()[1][1]).toEqual(expect.objectContaining({ ready: false, replyLoading: true, turnStatus: "running" }));
  mockStt.phase = "idle";
  mockVoice.turnStatus = "completed";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(gateCalls()).toHaveLength(2);
  await screen.unmount();
});

test("voice conversation uses the shared continuation transport and merges resumed speech before one send", async () => {
  mockUseActualStreamingStt = true;
  jest.spyOn(require("expo-modules-core"), "requireOptionalNativeModule").mockReturnValue(mockNativeStt);
  mockVoice.sendTranscript.mockImplementationOnce(async (_text, onAccepted) => { onAccepted?.(); });
  const { correctSttTranscript } = jest.requireMock("../../stt/sttSettingsClient") as {
    correctSttTranscript: jest.Mock;
  };
  let finishFirstCorrection!: (result: { changed: boolean; text: string }) => void;
  correctSttTranscript.mockImplementationOnce(() => new Promise((resolve) => { finishFirstCorrection = resolve; }));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await waitFor(() => expect(mockNativeStt.start).toHaveBeenCalledWith(
    "ws://runner.test/stream-stt?continuation=1", expect.any(Object)));
  const message = async (value: Record<string, unknown>) => {
    await act(async () => { mockNativeSttListeners.get("BittyStreamingSttMessage")?.({ data: JSON.stringify(value) }); });
  };
  await message({ type: "ready" });
  await message({ type: "transcript", text: "前半", isFinal: true });
  await message({ type: "candidate", revision: 1 });
  expect(mockNativeStt.abort).not.toHaveBeenCalled();
  await message({ type: "candidate_invalidated", revision: 1 });
  await message({ type: "segment_start" });
  await message({ type: "transcript", text: "後半", isFinal: true });
  await act(async () => { finishFirstCorrection({ changed: false, text: "古い結果" }); });
  expect(mockVoice.sendTranscript).not.toHaveBeenCalled();
  await message({ type: "candidate", revision: 2 });
  expect(mockNativeStt.commit).toHaveBeenCalledTimes(1);
  expect(mockNativeStt.commit).toHaveBeenCalledWith(2);
  expect(mockVoice.sendTranscript).toHaveBeenCalledTimes(1);
  expect(mockVoice.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
  expect(mockNativeStt.start).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("a widget voice target waits for foreground before announcing and recording once", async () => {
  AppState.currentState = "background";
  let changeState: ((state: AppStateStatus) => void) | undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    changeState = listener;
    return { remove: jest.fn() };
  });
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  expect(mockHookOrchestratorIds.at(-1)).toBe("other");
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
  expect(mockStt.start).not.toHaveBeenCalled();
  await act(async () => { changeState?.("active"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("調査で音声入力を準備します", expect.any(Object));
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  await act(async () => { changeState?.("active"); });
  expect(mockStt.start).toHaveBeenCalledTimes(1);
  screen.unmount();
});

test("a remote handoff destination never auto-starts after a rejected operation becomes ready", async () => {
  const controller = new AbortController();
  mockVoice.ready = false;
  mockVoice.turnStatus = "running";
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" initialControlSignal={controller.signal} />);
  expect(mockStt.start).not.toHaveBeenCalled();
  mockVoice.ready = true;
  mockVoice.turnStatus = "completed";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" initialControlSignal={controller.signal} />);
  expect(mockStt.start).not.toHaveBeenCalled();
  expect(mockSynthesizeSpeechStream).not.toHaveBeenCalled();
  await screen.unmount();
});

test("history shows a session divider before the affected user message only", async () => {
  mockVoice.history = [
    { role: "user", text: "買い物リスト", clientOperationId: "first" },
    { role: "assistant", text: "追加してよいですか？", clientOperationId: "first" },
    { role: "user", text: "追加してください", clientOperationId: "second", sessionSwitched: true },
    { role: "assistant", text: "追加しました", clientOperationId: "second" },
    { role: "user", text: "ありがとう", clientOperationId: "third" },
  ];
  mockVoice.reply = { text: "", operationId: "" };
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const history = within(screen.getByTestId("voice-history-messages"));
  expect(history.getAllByText("セッション切り替え")).toHaveLength(1);
  expect(history.queryByTestId("voice-session-switch-first")).toBeNull();
  expect(history.queryByTestId("voice-session-switch-third")).toBeNull();
  const content = history.getAllByText(/^(追加してよいですか？|セッション切り替え|追加してください)$/).map((node) => node.props.children);
  expect(content.indexOf("セッション切り替え")).toBeGreaterThan(content.indexOf("追加してよいですか？"));
  expect(content.indexOf("セッション切り替え")).toBeLessThan(content.indexOf("追加してください"));
});

test("main learning badge arrives during another chat and stays separate from chat unread", async () => {
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose}
    initialOrchestratorId="other" />);
  await waitFor(() => expect(mockQuestionHandlers.has("voice.unread.changed")).toBe(true));
  const emit = async (learningUnreadCount: number) => act(async () => {
    mockQuestionHandlers.get("voice.unread.changed")?.forEach((listener) => listener({ channel: "agent",
      op: "voice.unread.changed", payload: { orchestrators: [
        { id: "main", name: "メイン", icon: "", unreadCount: 2, learningUnreadCount },
        { id: "other", name: "調査", icon: "", unreadCount: 0 },
      ], selectedId: "other" } }));
  });
  await emit(3);
  expect(screen.getByTestId("voice-orchestrator-learning-unread-main")).toBeTruthy();
  expect(screen.getByTestId("voice-orchestrator-unread-main")).toBeTruthy();
  expect(screen.getByLabelText("メインに切り替え、新しく学んだこと 3件")).toBeTruthy();
  expect(screen.queryByTestId("voice-orchestrator-learning-unread-other")).toBeNull();
  expect(mockHookOrchestratorIds.at(-1)).toBe("other");
  await emit(0);
  expect(screen.queryByTestId("voice-orchestrator-learning-unread-main")).toBeNull();
  expect(screen.getByTestId("voice-orchestrator-unread-main")).toBeTruthy();
});
