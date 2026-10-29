import { Alert, Platform, StyleSheet } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StreamingSttFooter } from "../components/StreamingSttFooter";
import { VoiceConsultationScreen, type ConsultationRoom } from "./VoiceConsultationScreen";

const mockHandlers = new Map<string, (message: unknown) => void>();
let mockVisibleOwner = "";
let mockGeneration = 1;
let mockListedRoom: ConsultationRoom;
const mockRoom: ConsultationRoom = {
  id: "room-one", generation: 0, question: "共有メモを作る相談", participants: ["main", "b"],
  profiles: { main: { orchestratorId: "main", name: "A", introduction: "製品" },
    b: { orchestratorId: "b", name: "B", introduction: "実装" } },
  template: "相談の初期指示", turns: 1, maxTurns: 9, revision: 1, state: "running", reason: "",
  messages: [{ id: "u", seq: 1, speakerId: "user", source: "user", text: "共有メモを作る相談" },
    { id: "a", seq: 2, speakerId: "main", source: "participant", text: "小さく始めよう" }],
  run: { id: "run-b", orchestratorId: "b" },
};
const mockRequest = jest.fn(async (message: { op: string; payload?: Record<string, unknown> }) => {
  if (message.op === "voice.orchestrators.list") return { op: `${message.op}.result`, payload: {
    selectedId: "main", orchestrators: [{ id: "main", name: "A", publicIntroduction: "製品" }, { id: "b", name: "B", publicIntroduction: "実装" }],
  } };
  if (message.op === "voice.consultations.list") return { op: `${message.op}.result`, payload: {
    rooms: [mockListedRoom || mockRoom], introductions: { main: "製品", b: "実装" }, defaultTemplate: "相談の初期指示",
  } };
  return { op: `${message.op}.result`, payload: mockRoom };
});
const mockManager = {
  connect: jest.fn(async () => {}), request: mockRequest,
  subscribe: ({ op }: { op: string }, handler: (message: unknown) => void) => {
    mockHandlers.set(op, handler); return () => mockHandlers.delete(op);
  },
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => ({ connected: true, generation: mockGeneration }),
}));
jest.mock("../theme/VisualThemeContext", () => ({ useVisualTheme: () => {
  const { VISUAL_THEMES, DEFAULT_VISUAL_THEME_ID } = jest.requireActual("../theme/visualThemes");
  return { theme: VISUAL_THEMES[DEFAULT_VISUAL_THEME_ID], themeId: DEFAULT_VISUAL_THEME_ID };
} }));
jest.mock("../hooks/useVoiceUserInput", () => ({ useVoiceUserInput: (_manager: unknown, ownerId: string) => {
  mockVisibleOwner = ownerId; return { request: null, decide: jest.fn() };
} }));
jest.mock("../components/UserInputModal", () => ({ UserInputModal: () => null }));
jest.mock("../components/VoiceResetConfirmationModal", () => ({ VoiceResetConfirmationModal: () => null }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
let mockMessageSequence = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `message-id-${++mockMessageSequence}` }));
jest.mock("../keyboardController", () => ({ KeyboardAvoidingView: require("react-native").View }));

jest.mock("../components/AnswerLearningDetails", () => ({ AnswerLearningDetails: () => null }));
jest.mock("../hooks/useReduceMotionEnabled", () => ({ useReduceMotionEnabled: () => true }));
jest.mock("react-native-reanimated", () => ({
  __esModule: true, default: { View: require("react-native").View },
  FadeOut: { duration: () => ({}) }, ZoomIn: { springify: () => ({ damping: () => ({}) }) },
  useFrameCallback: () => {}, useSharedValue: (value: unknown) => ({ value }), withTiming: (value: unknown) => value,
}));
jest.mock("@shopify/react-native-skia", () => {
  const { View } = require("react-native");
  return { Canvas: View, Group: View, Path: View, BlurMask: () => null, SweepGradient: () => null,
    vec: (x: number, y: number) => ({ x, y }), Skia: { Path: { Make: () => ({ addRRect() {} }) },
      RRectXY: () => ({}), XYWHRect: () => ({}) } };
});

async function typeTranscript(screen: Awaited<ReturnType<typeof render>>, text: string) {
  const current = screen.getByTestId("streaming-stt-transcript");
  if (!current.props.onChangeText) await fireEvent.press(current);
  await fireEvent.changeText(screen.getByTestId("streaming-stt-transcript"), text);
}
async function submitTranscript(screen: Awaited<ReturnType<typeof render>>) {
  const input = screen.getByTestId("streaming-stt-transcript");
  await fireEvent(input, "submitEditing", { nativeEvent: { text: input.props.value } });
}

beforeEach(() => { jest.clearAllMocks(); mockHandlers.clear(); mockVisibleOwner = ""; mockMessageSequence = 0; mockGeneration = 1; mockListedRoom = mockRoom; });

test("gathers identity icons in selected order and creates only an empty room", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("新しい相談"));
  expect(screen.queryByLabelText("相談の議題")).toBeNull();
  expect(screen.queryByLabelText("Aの紹介")).toBeNull();
  await fireEvent.press(screen.getByLabelText("B"));
  await fireEvent.press(screen.getByLabelText("A"));
  expect(screen.getByLabelText("A").props.accessibilityState.checked).toBe(true);
  await fireEvent(screen.getByLabelText("A"), "longPress");
  expect(alert).toHaveBeenCalledWith("A", "製品");
  await fireEvent.press(screen.getByLabelText("相談を作る"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.create", payload: { participants: ["b", "main"] },
  })));
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.consultations.resume")).toBe(false);
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.orchestrators.select")).toBe(false);
  alert.mockRestore();
});

test("shows speaker identity, follows the active participant for questions, and sends supplements and stop separately", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  expect(screen.getByText("小さく始めよう")).toBeTruthy();
  expect(mockVisibleOwner).toBe("b");
  await typeTranscript(screen, "期限を明日に訂正");
  await submitTranscript(screen);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.supplement", payload: { roomId: "room-one", text: "期限を明日に訂正", messageId: "message-id-1" },
  })));
  await fireEvent.press(screen.getByLabelText("相談を停止"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.consultations.stop" })));
});

test("late snapshots do not overwrite newer room messages, and closing the UI does not stop the consultation", async () => {
  const close = jest.fn();
  const screen = await render(<VoiceConsultationScreen onClose={close} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  await act(async () => {
    mockHandlers.get("voice.consultations.changed")?.({ payload: { ...mockRoom, revision: 3,
      messages: [...mockRoom.messages, { id: "b", seq: 3, speakerId: "b", source: "participant", text: "Bから新しい案" }] } });
    mockHandlers.get("voice.consultations.changed")?.({ payload: { ...mockRoom, revision: 2 } });
  });
  expect(screen.getByText("Bから新しい案")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByLabelText("相談を閉じる"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.consultations.stop")).toBe(false);
});

test("room settings update the next-run template without changing ordinary settings or exposing an invitation button", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  expect(screen.queryByLabelText("＋追加")).toBeNull();
  await fireEvent.press(screen.getByLabelText("設定"));
  await fireEvent.press(screen.getByLabelText("相談の進め方を編集"));
  await fireEvent.changeText(screen.getByLabelText("相談の進め方"), "次の手番から適用");
  await fireEvent.press(screen.getByLabelText("設定を保存"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.configure", payload: expect.objectContaining({ template: "次の手番から適用" }),
  })));
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.settings.update")).toBe(false);
});


test("a lost send response retries the same message ID and budget reset while edited text gets a new identity", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await screen.findByText("共有メモを作る相談");
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  await typeTranscript(screen, "同じ指示");
  mockRequest.mockRejectedValueOnce(new Error("response lost"));
  await submitTranscript(screen);
  await screen.findByText("response lost");
  await submitTranscript(screen);
  await waitFor(() => expect(screen.queryByDisplayValue("同じ指示")).toBeNull());
  expect(screen.getByTestId("streaming-stt-transcript").props.accessibilityLabel).toBe("Responding");
  const sends = mockRequest.mock.calls.filter(([message]) => message.op === "voice.consultations.supplement");
  expect(sends.map(([message]) => message.payload?.messageId)).toEqual(["message-id-1", "message-id-1"]);
  await typeTranscript(screen, "別の指示");
  await submitTranscript(screen);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.consultations.supplement",
    payload: expect.objectContaining({ messageId: "message-id-2", text: "別の指示" }) })));
});


test("paused unknown and reset-confirmation turns still expose the shared stop control", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await screen.findByText("共有メモを作る相談");
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  for (const [index, reason] of ["unknown", "confirmation_required"].entries()) {
    await act(async () => mockHandlers.get("voice.consultations.changed")?.({ payload: {
      ...mockRoom, state: "paused", reason, revision: index + 2,
    } }));
    expect(screen.getByLabelText("確認して再開")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("相談を停止"));
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.consultations.stop" }));
  }
});


jest.mock("react-native-enriched-markdown", () => ({ EnrichedMarkdownText: (props: { markdown: string }) => {
  const React = require("react"), { Text } = require("react-native");
  return React.createElement(Text, props, props.markdown);
} }));
jest.mock("../components/MermaidCodeBlock", () => ({ MermaidCodeBlock: () => null }));

test("live snapshots survive reordered notifications, then final replaces the draft and rejects late output", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await screen.findByLabelText("共有メモを作る相談");
  await fireEvent.press(screen.getByLabelText("共有メモを作る相談"));
  const progress = { roomId: mockRoom.id, runId: mockRoom.run!.id, generation: 0, seq: 2,
    messages: [{ id: "text", phase: "final_answer", text: "確認できた結論" }], tools: [] };
  await act(async () => mockHandlers.get("voice.consultations.progress")?.({ payload: progress }));
  expect(screen.getAllByText("確認できた結論")).toHaveLength(1);
  await act(async () => mockHandlers.get("voice.consultations.changed")?.({ payload: mockRoom }));
  expect(screen.getByText("確認できた結論")).toBeTruthy();
  await act(async () => mockHandlers.get("voice.consultations.progress")?.({ payload: { ...progress, seq: 1,
    messages: [{ id: "text", phase: "final_answer", text: "遅い古い差分" }] } }));
  expect(screen.queryByText("遅い古い差分")).toBeNull();
  await act(async () => mockHandlers.get("voice.consultations.changed")?.({ payload: { ...mockRoom, revision: 2,
    run: null, state: "idle", reason: "all_pass", messages: [...mockRoom.messages,
      { id: mockRoom.run!.id, seq: 3, speakerId: "b", source: "participant", text: "確認できた結論" }] } }));
  expect(screen.getAllByText("確認できた結論")).toHaveLength(1);
  await act(async () => mockHandlers.get("voice.consultations.progress")?.({ payload: { ...progress, seq: 30,
    messages: [{ id: "text", phase: "final_answer", text: "完了後の遅い出力" }] } }));
  expect(screen.queryByText("完了後の遅い出力")).toBeNull();
});

test("real tool previews remain available when a run becomes unknown, without presenting an unconfirmed answer as final", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await screen.findByLabelText("共有メモを作る相談");
  await fireEvent.press(screen.getByLabelText("共有メモを作る相談"));
  const progress = { roomId: mockRoom.id, runId: mockRoom.run!.id, generation: 0, seq: 3,
    messages: [{ id: "c", phase: "commentary", text: "資料を確認しています" }],
    tools: [{ id: "t", type: "commandExecution", name: "exec_command", status: "unknown", input: "cat fixture.md", output: "Synthetic private result", outputTruncated: true }] };
  await act(async () => mockHandlers.get("voice.consultations.progress")?.({ payload: progress }));
  expect(screen.getByText("資料を確認しています")).toBeTruthy();
  await act(async () => mockHandlers.get("voice.consultations.changed")?.({ payload: { ...mockRoom, revision: 2, state: "paused", reason: "unknown" } }));
  expect(screen.getByText("B · 結果未確認の作業記録")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("作業の記録"));
  expect(screen.getByText("cat fixture.md")).toBeTruthy();
  expect(screen.getByText(/Synthetic private result/)).toBeTruthy();
  expect(screen.getAllByText(/結果未確認/).some((node) => String(node.props.children).includes("コマンド"))).toBe(true);
  expect(screen.getByText(/出力の表示は一部省略/)).toBeTruthy();
});

test("streaming does not force scrolling while reading earlier messages", async () => {
  const { ScrollView } = require("react-native");
  const scroll = jest.spyOn(ScrollView.prototype, "scrollToEnd");
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await screen.findByLabelText("共有メモを作る相談");
  await fireEvent.press(screen.getByLabelText("共有メモを作る相談"));
  const history = screen.getByTestId("consultation-messages");
  await fireEvent(history, "scroll", { nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 1200 }, layoutMeasurement: { height: 500 } } });
  scroll.mockClear();
  await fireEvent(history, "contentSizeChange", 390, 1300);
  expect(scroll).not.toHaveBeenCalled();
  await fireEvent(history, "scroll", { nativeEvent: { contentOffset: { y: 800 }, contentSize: { height: 1300 }, layoutMeasurement: { height: 500 } } });
  await fireEvent(history, "contentSizeChange", 390, 1400);
  expect(scroll).toHaveBeenCalledWith({ animated: false });
  scroll.mockRestore();
});

test("uses the ordinary orchestrator panel, glow, Enter submission and status while preserving edits during acceptance", async () => {
  const previousOS = Platform.OS; Object.defineProperty(Platform, "OS", { value: "macos", configurable: true });
  try {
    const ordinary = await render(<StreamingSttFooter transcript="" phase="idle" voiceStatus="responding" reduceMotion onStop={jest.fn()} />);
    const ordinaryPanel = StyleSheet.flatten(ordinary.getByTestId("streaming-stt-panel").props.style);
    expect(ordinary.getByLabelText("録音を停止")).toBeTruthy();
    expect(ordinary.getByTestId("streaming-stt-transcript").props.onPress).toBeUndefined();
    await ordinary.unmount();
    const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
    await screen.findByText("共有メモを作る相談"); await fireEvent.press(screen.getByText("共有メモを作る相談"));
    expect(screen.getByTestId("streaming-stt-glow")).toBeTruthy();
    expect(screen.getByTestId("streaming-stt-transcript").props.children).toBe("responding...");
    expect(StyleSheet.flatten(screen.getByTestId("streaming-stt-panel").props.style)).toEqual(ordinaryPanel);
    expect(screen.queryByTestId("chat-composer-input")).toBeNull();
    expect(screen.queryByTestId("composer-fullscreen-input")).toBeNull();
    await typeTranscript(screen, "未確定");
    const input = screen.getByTestId("streaming-stt-transcript");
    expect(input.props.submitKeyEvents).toEqual([{ key: "Enter" }]);
    expect(input.props.submitBehavior).toBe("submit");
    let release!: (response: unknown) => void;
    mockRequest.mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }) as never);
    await fireEvent(input, "submitEditing", { nativeEvent: { text: "日本語を確定" } });
    await waitFor(() => expect(release).toBeDefined());
    await typeTranscript(screen, "送信中の新しい編集");
    await act(() => release({ op: "voice.consultations.supplement.result", payload: mockRoom }));
    expect(screen.getByTestId("streaming-stt-transcript").props.value).toBe("送信中の新しい編集");
  } finally { Object.defineProperty(Platform, "OS", { value: previousOS, configurable: true }); }
});

test("reads only newly published live speech, never opened or reconnected history, and allows manual history playback", async () => {
  const state = { active: false, messageId: "" };
  const synthesize = jest.fn(async (_text, target) => { state.active = true; state.messageId = target.messageId; });
  const stop = jest.fn(async (options) => { if (options?.expectedMessageId === state.messageId) state.active = false; });
  const playback = { synthesizeSpeechStream: synthesize, stopTtsPlayback: stop, isTtsPlaybackActive: false,
    ttsUiStatus: "idle" as const, getPlaybackState: () => ({ ...state }) };
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} playback={playback} />);
  await screen.findByText("共有メモを作る相談"); await fireEvent.press(screen.getByText("共有メモを作る相談"));
  expect(synthesize).not.toHaveBeenCalled();
  const live = { ...mockRoom, revision: 2, messages: [...mockRoom.messages,
    { id: "b-live", seq: 3, speakerId: "b", source: "participant", text: "新しい提案です" }] };
  await act(() => mockHandlers.get("voice.consultations.changed")?.({ payload: live }));
  await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
  expect(synthesize).toHaveBeenCalledWith("新しい提案です", expect.objectContaining({ scope: "voice", orchestratorId: "b" }));
  await act(() => mockHandlers.get("voice.consultations.changed")?.({ payload: live }));
  expect(synthesize).toHaveBeenCalledTimes(1);
  mockListedRoom = { ...live, revision: 3, messages: [...live.messages,
    { id: "missed", seq: 4, speakerId: "main", source: "participant", text: "再接続前の発言です" }] };
  mockGeneration += 1;
  await screen.rerender(<VoiceConsultationScreen onClose={jest.fn()} playback={{ ...playback }} />);
  await screen.findByText("再接続前の発言です");
  await act(() => mockHandlers.get("voice.consultations.changed")?.({ payload: mockListedRoom }));
  expect(synthesize).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getAllByLabelText("Aの返答を読み上げ")[0]);
  await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
  expect(synthesize).toHaveBeenLastCalledWith("小さく始めよう", expect.objectContaining({ orchestratorId: "main" }));
  const firstManualId = state.messageId;
  await fireEvent.press(screen.getByTestId("streaming-stt-speaking-cancel"));
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: firstManualId }));
  expect(mockRequest.mock.calls.some(([request]) => request.op === "voice.consultations.stop")).toBe(false);
  await fireEvent.press(screen.getAllByLabelText("Aの返答を読み上げ")[0]);
  await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(3));
  const manualId = state.messageId; await screen.unmount();
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ expectedMessageId: manualId }));
});
