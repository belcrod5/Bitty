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
    selectedId: "main", orchestrators: [{ id: "main", name: "A" }, { id: "b", name: "B" }],
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
jest.mock("expo-crypto", () => ({ randomUUID: () => "message-id" }));
jest.mock("../keyboardController", () => ({ KeyboardAvoidingView: require("react-native").View }));

beforeEach(() => { jest.clearAllMocks(); mockHandlers.clear(); mockVisibleOwner = ""; });

test("creates a separate consultation with selected order, reusable introductions and editable instructions", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("新しい相談"));
  await fireEvent.changeText(screen.getByLabelText("相談の議題"), "新しい議題");
  await fireEvent.press(screen.getByLabelText("B"));
  await fireEvent.press(screen.getByLabelText("A"));
  await fireEvent.changeText(screen.getByLabelText("相談の進め方"), "追加の会話依頼");
  await fireEvent.press(screen.getByLabelText("相談を始める"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.create", payload: expect.objectContaining({
      question: "新しい議題", participants: ["b", "main"], template: "追加の会話依頼", profiles: { main: "製品", b: "実装" },
    }),
  })));
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.orchestrators.select")).toBe(false);
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.settings.update")).toBe(false);
});

test("shows speaker identity, follows the active participant for questions, and sends supplements and stop separately", async () => {
  const screen = await render(<VoiceConsultationScreen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("共有メモを作る相談")).toBeTruthy());
  await fireEvent.press(screen.getByText("共有メモを作る相談"));
  expect(screen.getByText("小さく始めよう")).toBeTruthy();
  expect(mockVisibleOwner).toBe("b");
  await fireEvent.changeText(screen.getByLabelText("相談への補足"), "期限を明日に訂正");
  await fireEvent.press(screen.getByLabelText("補足を送る"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.consultations.supplement", payload: { roomId: "room-one", text: "期限を明日に訂正", messageId: "message-id" },
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
