import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { VoiceConsultationScreen, type ConsultationRoom } from "./VoiceConsultationScreen";

const mockHandlers = new Map<string, (message: unknown) => void>();
let mockVisibleOwner = "";
const mockRoom: ConsultationRoom = {
  id: "room-one", question: "共有メモを作る相談", participants: ["main", "b"],
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
    rooms: [mockRoom], introductions: { main: "製品", b: "実装" }, defaultTemplate: "相談の初期指示",
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
  useRunnerWebSocketSnapshot: () => ({ connected: true, generation: 1 }),
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
jest.mock("../styles", () => ({ useAppStyles: () => ({ chatInputWrapper: {} }) }));
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

beforeEach(() => { jest.clearAllMocks(); mockHandlers.clear(); mockVisibleOwner = ""; mockMessageSequence = 0; });

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
  await fireEvent.changeText(screen.getByLabelText("メッセージを入力"), "期限を明日に訂正");
  await fireEvent.press(screen.getByLabelText("送信"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.supplement", payload: { roomId: "room-one", text: "期限を明日に訂正", messageId: "message-id-1" },
  })));
  await fireEvent.press(screen.getByLabelText("停止"));
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
  await fireEvent.changeText(screen.getByLabelText("メッセージを入力"), "同じ指示");
  mockRequest.mockRejectedValueOnce(new Error("response lost"));
  await fireEvent.press(screen.getByLabelText("送信"));
  await screen.findByText("response lost");
  await fireEvent.press(screen.getByLabelText("送信"));
  await waitFor(() => expect(screen.getByLabelText("メッセージを入力").props.value).toBe(""));
  const sends = mockRequest.mock.calls.filter(([message]) => message.op === "voice.consultations.supplement");
  expect(sends.map(([message]) => message.payload?.messageId)).toEqual(["message-id-1", "message-id-1"]);
  await fireEvent.changeText(screen.getByLabelText("メッセージを入力"), "別の指示");
  await fireEvent.press(screen.getByLabelText("送信"));
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
    await fireEvent.press(screen.getByLabelText("停止"));
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.consultations.stop" }));
  }
});
