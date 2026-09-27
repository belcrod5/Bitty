import { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { VoiceConversationScreen } from "./VoiceConversationScreen";

const mockAbort = jest.fn(async () => undefined);
const mockStopTtsPlayback = jest.fn(async () => undefined);
const mockSynthesizeSpeechStream = jest.fn(async (): Promise<void> => undefined);
const mockOnClose = jest.fn();
const mockLogSessionDiag = jest.fn();
const mockVoice = {
  ready: true,
  turnStatus: "completed",
  reply: { text: "表示しない返答本文", operationId: "operation-1" },
  error: "",
  contextStats: { estimatedContextUsagePercent: 31, unsummarizedMessageCount: 8, memoryCharacterCount: 55 },
  history: [] as { role: "user" | "assistant"; text: string; clientOperationId: string }[],
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
let mockFooterProps: { voiceContextStats?: unknown; transcript: string; draftTranscript?: string; statusText?: string; voiceStatus?: "responding" | "speaking"; reduceMotion?: boolean; phase: string; onStop: () => void; onFocus?: () => void; onChangeText?: (text: string) => void; onSubmit?: (text: string, onAccepted: () => boolean) => Promise<void> } | null = null;
const mockFooterRenders: { transcript: string; voiceStatus?: "responding" | "speaking" }[] = [];
let mockReduceMotion: boolean | null = false;

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
  StreamingSttFooter: (props: { voiceContextStats?: unknown; transcript: string; statusText?: string; voiceStatus?: "responding" | "speaking"; reduceMotion?: boolean; phase: string; onStop: () => void; onFocus?: () => void; onChangeText?: (text: string) => void; onSubmit?: (text: string, onAccepted: () => boolean) => Promise<void> }) => {
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
    default: { View: (props: Record<string, unknown>) => ReactModule.createElement(View, props) },
    FadeIn: { duration: (duration: number) => ({ type: "fade-in", duration }) },
    FadeOut: { duration: (duration: number) => ({ type: "fade-out", duration }) },
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
  mockVoice.turnStatus = "completed";
  mockVoice.error = "";
  mockVoice.history = [];
  mockVoice.historyError = "";
  mockReduceMotion = false;
});

test("the footer reveals stored messages and closes the history panel", async () => {
  mockVoice.history = [
    { role: "user", text: "最初の質問", clientOperationId: "one" },
    { role: "assistant", text: "最初の返答", clientOperationId: "one" },
  ];
  const screen = await render(<VoiceConversationScreen {...playback} onClose={mockOnClose} />);
  await fireEvent.press(screen.getByTestId("voice-history-open"));
  expect(screen.getByText("最初の質問")).toBeTruthy();
  expect(screen.getByText("最初の返答")).toBeTruthy();
  expect(mockVoice.refreshHistory).toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId("voice-history-handle"));
  expect(screen.queryByText("最初の質問")).toBeNull();
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
    width: "100%",
  });
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-keyboard-avoiding").props.style)).toMatchObject({
    position: "absolute", top: 0, bottom: 0, justifyContent: "flex-end",
  });
  expect(screen.getByTestId("voice-conversation-keyboard-avoiding").props.behavior).toBe("padding");
  expect(screen.getByTestId("voice-conversation-screen").props.style).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId("voice-conversation-content").props.style)).toMatchObject({
    paddingHorizontal: 20, paddingBottom: 20,
  });
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
