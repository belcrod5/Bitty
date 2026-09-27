import { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Platform, ScrollView, StyleSheet } from "react-native";
import { DEFAULT_VISUAL_THEME_ID, VISUAL_THEMES } from "../theme/visualThemes";
import { VoiceConversationScreen } from "./VoiceConversationScreen";

const mockWithTiming = jest.fn((value: number, _config?: unknown) => value);
const mockBackdropOpacity = { value: 0 };
const mockAbort = jest.fn(async () => undefined);
const mockStopTtsPlayback = jest.fn(async () => undefined);
const mockSynthesizeSpeechStream = jest.fn(async (): Promise<void> => undefined);
const mockOnClose = jest.fn();
const mockLogSessionDiag = jest.fn();
const mockVoice = {
  ready: true,
  logicalConversationId: "conversation-one",
  turnStatus: "completed",
  reply: { text: "表示しない返答本文", operationId: "operation-1" },
  error: "",
  contextStats: { estimatedContextUsagePercent: 31, unsummarizedMessageCount: 8, memoryCharacterCount: 55 },
  history: [] as { role: "user" | "assistant"; text: string; clientOperationId: string; at?: string }[],
  historyError: "",
  refreshHistory: jest.fn(async () => undefined),
  setError: jest.fn(),
  sendTranscript: jest.fn(async () => undefined),
  interrupt: jest.fn(),
};
const mockStt = {
  active: false,
  phase: "idle",
  start: jest.fn(),
  stop: jest.fn(),
  sendManualTranscript: jest.fn(async (_text: string, onAccepted: () => boolean) => { onAccepted(); }),
  abort: mockAbort,
};
let mockOnCompleted: ((text: string, operationId: string) => void) | null = null;
let mockOnJob: ((jobId: string, operationId: string) => void) | null = null;
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
  onSubmit?: (text: string, onAccepted: () => boolean) => Promise<void>;
  historyExpanded?: boolean;
  onHistoryToggle?: () => void;
};
let mockFooterProps: MockFooterProps | null = null;
const mockFooterRenders: { transcript: string; voiceStatus?: "responding" | "speaking" }[] = [];
let mockReduceMotion: boolean | null = false;
const initialPlatform = Platform.OS;

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
  useVoiceConversation: (onCompleted: (text: string, operationId: string) => void, _onApproval: unknown,
    _onResolved: unknown, onJob: (jobId: string, operationId: string) => void) => {
    mockOnCompleted = onCompleted;
    mockOnJob = onJob;
    return mockVoice;
  },
}));
jest.mock("../../stt/useStreamingStt", () => ({ useStreamingStt: (options: { ttsPlaybackActive: boolean; onDiagnostic: (event: string, payload: Record<string, unknown>) => void }) => {
  mockLastSttOptions = options;
  return mockStt;
} }));
jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => mockReduceMotion }));
jest.mock("../components/StreamingSttFooter", () => ({
  StreamingSttFooter: (props: MockFooterProps) => {
    const ReactModule = require("react");
    const { Text, TouchableOpacity, View } = require("react-native");
    mockFooterProps = { ...props, draftTranscript: props.transcript, transcript: props.statusText || props.transcript };
    mockFooterRenders.push({ transcript: props.statusText || props.transcript, voiceStatus: props.voiceStatus });
    return ReactModule.createElement(View, { testID: "streaming-stt-footer" },
      ReactModule.createElement(Text, null, props.statusText || props.transcript),
      ReactModule.createElement(TouchableOpacity, { testID: "streaming-stt-stop", onPress: props.onStop }));
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
    gesture.onEnd = (callback: (event: { translationY: number }) => void) => { gesture.end = callback; return gesture; };
    return gesture;
  } },
  GestureDetector: ({ gesture, children }: { gesture: Record<string, any>; children: React.ReactElement }) => {
    const ReactModule = require("react");
    return ReactModule.cloneElement(children, { onMockGestureEnd: gesture.end,
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
    FadeInDown: { duration: (duration: number) => ({ type: "fade-in-down", duration }) },
    FadeOut: { duration: (duration: number) => ({ type: "fade-out", duration }) },
    FadeOutDown: { duration: (duration: number) => ({ type: "fade-out-down", duration }) },
    runOnJS: (callback: unknown) => callback,
    useSharedValue: () => mockBackdropOpacity,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    withTiming: (value: number, config: unknown) => mockWithTiming(value, config),
  };
});

const playback = {
  synthesizeSpeechStream: mockSynthesizeSpeechStream,
  stopTtsPlayback: mockStopTtsPlayback,
  isTtsPlaybackActive: false,
  ttsUiStatus: "idle" as const,
};

function ClosableVoiceScreen() {
  const [open, setOpen] = useState(true);
  return open ? <VoiceConversationScreen {...playback} onClose={() => {
    mockOnClose();
    setOpen(false);
  }} /> : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLastSttOptions = null;
  mockFooterProps = null;
  mockFooterRenders.length = 0;
  mockOnCompleted = null;
  mockOnJob = null;
  mockStt.active = false;
  mockVoice.ready = true;
  mockVoice.logicalConversationId = "conversation-one";
  mockVoice.turnStatus = "completed";
  mockVoice.error = "";
  mockVoice.history = [];
  mockVoice.historyError = "";
  mockBackdropOpacity.value = 0;
  mockReduceMotion = false;
});
afterEach(() => { Object.defineProperty(Platform, "OS", { configurable: true, value: initialPlatform }); });

test("the footer reveals stored messages and closes the history panel", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
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
  expect(mockWithTiming).toHaveBeenCalledWith(0, { duration: 240 });
  expect(screen.queryByTestId("voice-history-open")).toBeNull();
  expect(screen.getByTestId("voice-history-swipe-area").props).toMatchObject({
    gestureVerticalRange: [-24, 24], gestureHorizontalRange: [-32, 32],
  });
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  expect(mockWithTiming).toHaveBeenCalledWith(1, { duration: 240 });
  expect(mockBackdropOpacity.value).toBe(1);
  expect(screen.getByTestId("voice-conversation-backdrop").props.pointerEvents).toBe("auto");
  const blur = screen.getByTestId("voice-conversation-board-blur");
  expect(screen.getByTestId("voice-conversation-keyboard-avoiding").children[0]).toBe(blur);
  expect(blur.props).toMatchObject({ pointerEvents: "none", intensity: 80, tint: "dark" });
  expect(StyleSheet.flatten(blur.props.style)).toMatchObject({
    position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
  });
  expect(StyleSheet.flatten(blur.props.style).opacity).toBeUndefined();
  expect(screen.getByTestId("voice-conversation-history").props).toMatchObject({
    entering: { type: "fade-in-down", duration: 240 },
    exiting: { type: "fade-out-down", duration: 200 },
  });
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-history").props.style)).toMatchObject({ flex: 1, width: "100%" });
  expect(StyleSheet.flatten(screen.getByTestId("voice-history-messages").props.style)).toMatchObject({ flex: 1 });
  expect(screen.getByTestId("voice-history-messages").props.contentContainerStyle).toMatchObject({ paddingHorizontal: 20 });
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
  expect(screen.getByText("09/27 12:34")).toBeTruthy();
  expect(screen.getByText("09/27 12:35")).toBeTruthy();
  const colors = VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID].colors;
  expect(StyleSheet.flatten(screen.getByText("最初の質問").parent?.props.style).backgroundColor).toBe(colors.accent);
  expect(StyleSheet.flatten(screen.getByText("最初の返答").parent?.props.style).backgroundColor).toBe(colors.surfaceMuted);
  expect(screen.getByText("最初の質問").props.style.color).toBe(colors.textOnAccent);
  expect(mockVoice.refreshHistory).toHaveBeenCalled();
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: 80 }); });
  expect(screen.getByText("最初の質問")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("voice-history-close")); });
  expect(mockWithTiming).toHaveBeenLastCalledWith(0, { duration: 240 });
  expect(screen.getByTestId("voice-conversation-backdrop").props.pointerEvents).toBe("none");
  expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
  expect(screen.queryByText("最初の質問")).toBeNull();
  await screen.unmount();
});

test("macOS and Android keep the dark backdrop without loading native blur", async () => {
  for (const os of ["macos", "android"]) {
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
    await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
    expect(screen.queryByTestId("voice-conversation-board-blur")).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-backdrop").props.style).backgroundColor)
      .toBe("rgba(0, 0, 0, 0.68)");
    await screen.unmount();
  }
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
  expect(mockWithTiming).toHaveBeenLastCalledWith(1, { duration: 0 });
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

test("an open history panel reloads when voice.open becomes ready or changes conversation", async () => {
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
  expect(mockVoice.refreshHistory).toHaveBeenCalledTimes(1);
  mockVoice.logicalConversationId = "conversation-two";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockVoice.refreshHistory).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

test("new history content keeps the position while older messages are being read", async () => {
  const scrollToEnd = jest.spyOn(ScrollView.prototype, "scrollToEnd").mockImplementation(() => undefined);
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { screen.getByTestId("voice-history-swipe-area").props.onMockGestureEnd({ translationY: -80 }); });
  const history = screen.getByTestId("voice-history-messages");
  await act(async () => { history.props.onContentSizeChange(); });
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 80 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  await act(async () => { history.props.onContentSizeChange(); });
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  mockVoice.logicalConversationId = "conversation-two";
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { history.props.onContentSizeChange(); });
  expect(scrollToEnd).toHaveBeenCalledTimes(2);
  await act(async () => { history.props.onScroll({ nativeEvent: {
    contentOffset: { y: 500 }, contentSize: { height: 800 }, layoutMeasurement: { height: 300 },
  } }); });
  await act(async () => { history.props.onContentSizeChange(); });
  expect(scrollToEnd).toHaveBeenCalledTimes(3);
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

  expect(mockStt.stop).toHaveBeenCalledTimes(1);
  expect(mockOnClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("streaming-stt-footer")).toBeNull();
  expect(screen.queryByTestId("voice-conversation-transition")).toBeNull();
  expect(mockAbort).toHaveBeenCalled();
  expect(mockStopTtsPlayback).not.toHaveBeenCalled();

  mockVoice.ready = true;
  await screen.rerender(<ClosableVoiceScreen />);
  expect(mockStt.start).not.toHaveBeenCalled();
});

test("stopping active recording closes the footer immediately", async () => {
  mockStt.active = true;
  const screen = await render(<ClosableVoiceScreen />);
  await fireEvent.press(screen.getByTestId("streaming-stt-stop"));

  expect(mockStt.stop).toHaveBeenCalledTimes(1);
  expect(mockVoice.interrupt).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("streaming-stt-footer")).toBeNull();
  expect(mockAbort).toHaveBeenCalled();
});

test("editing before voice is ready prevents late auto-start and sends only the typed draft", async () => {
  mockVoice.ready = false;
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockFooterProps?.onFocus?.(); });
  expect(mockStt.stop).toHaveBeenCalledTimes(1);
  await act(async () => { mockFooterProps?.onChangeText?.("typed draft"); });
  expect(mockFooterProps?.draftTranscript).toBe("typed draft");
  mockVoice.ready = true;
  await screen.rerender(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(mockStt.start).not.toHaveBeenCalled();
  await act(async () => { await mockFooterProps?.onSubmit?.("typed draft", () => true); });
  expect(mockStt.sendManualTranscript).toHaveBeenCalledWith("typed draft", expect.any(Function));
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
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  expect(screen.queryByText("表示しない返答本文")).toBeNull();
  expect(screen.queryByTestId("voice-conversation-replay")).toBeNull();

  await act(async () => { mockOnCompleted?.("返答", "operation-1"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("返答", { messageId: "operation-1" });
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
  let finishSynthesis!: () => void;
  mockSynthesizeSpeechStream.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishSynthesis = resolve;
  }));
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await act(async () => { mockOnJob?.("voice-job", "operation-1"); });
  expect(mockSynthesizeSpeechStream).toHaveBeenCalledWith("", { messageId: "operation-1", jobId: "voice-job" });
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

test("closing over active chat playback does not stop TTS without a voice reply", async () => {
  const screen = await render(<VoiceConversationScreen
    {...playback}
    isTtsPlaybackActive
    ttsUiStatus="playing"
    onClose={mockOnClose}
  />);
  await screen.unmount();

  expect(mockStopTtsPlayback).not.toHaveBeenCalled();
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
