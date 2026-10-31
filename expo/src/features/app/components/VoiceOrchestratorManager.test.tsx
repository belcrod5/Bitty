import { subscribeVoiceOrchestrators } from "../utils/voiceOrchestratorClient";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { Alert, StyleSheet } from "react-native";
import { AppModal } from "./AppModal";
import { VoiceOrchestratorManager } from "./VoiceOrchestratorManager";

const icon = "data:image/png;base64,iVBORw0KGgo=";
let mockLegacySettings = false;
let mockSaveFailure = false;
let mockMainInstruction = "Be helpful.";
let mockIsolationVersion = 1;
let mockRealSettingsSelect = false;
const mockPickIcon = jest.fn(async () => icon);
const mockRequest = jest.fn(async (message: { op: string; payload?: Record<string, unknown> }, _options?: { timeoutMs?: number }) => {
  const { op, payload } = message;
  if (op === "voice.settings") return { op: `${op}.result`, payload: {
    orchestratorId: payload?.orchestratorId,
    isolationVersion: mockIsolationVersion,
    name: payload?.orchestratorId === "main" ? "メイン" : "調査",
    icon: "", model: "gpt-6-luna", effort: "low", systemInstruction: mockMainInstruction,
    ttsProvider: "aivisspeech", voiceId: "",
    topicModel: "gpt-6-luna", topicEffort: "low",
    defaults: { model: "gpt-6-luna", effort: "low", systemInstruction: "Be helpful.",
      topicModel: "gpt-6-luna", topicEffort: "low", overviewModel: "gpt-6-luna", overviewEffort: "low" },
    ...(!mockLegacySettings
      ? { overviewModel: "gpt-6-luna", overviewEffort: "low" } : {}),
    models: [
      { modelId: "gpt-6-luna", label: "Luna", effortOptions: ["low"] },
      { modelId: "another-model", label: "Another", effortOptions: ["medium", "high"] },
    ], storedMessageCount: 2, memoryCharacterCount: 12,
  } };
  if (op === "voice.orchestrators.introduction.draft") return { op: `${op}.result`, payload: {
    orchestratorId: payload?.orchestratorId, introduction: "調査と実装の相談を担当します。",
  } };
  if (op === "voice.orchestrators.create") return { op: `${op}.result`, payload: {
    orchestrators: [...list.orchestrators, { id: "new-id", name: payload?.name, icon: payload?.icon }],
    selectedId: "main",
  } };
  if (op === "voice.orchestrators.update") {
    if (mockSaveFailure) throw new Error("保存エラー");
    return { op: `${op}.result`, payload: {
      orchestrators: list.orchestrators.map((item) => item.id === payload?.orchestratorId
        ? { ...item, name: payload.name, icon: payload.icon } : item), selectedId: "main",
    } };
  }
  if (op === "voice.orchestrators.delete") return { op: `${op}.result`, payload: {
    orchestrators: [list.orchestrators[0]], selectedId: "main",
  } };
  if (op === "voice.memory.clear" || op === "voice.messages.clear") return { op: `${op}.result`, payload: {
    orchestratorId: payload?.orchestratorId, memoryCharacterCount: 0, storedMessageCount: 0,
  } };
  throw new Error(`unexpected ${op}`);
});
const list = { orchestrators: [{ id: "main", name: "メイン", icon: "" },
  { id: "other", name: "調査", icon: "" }], selectedId: "main" };
const mockManager = {
  request: async (message: Parameters<typeof mockRequest>[0], options?: { timeoutMs?: number; onResponse?: (message: unknown) => void }) => {
    const response = options?.timeoutMs ? await mockRequest(message, { timeoutMs: options.timeoutMs }) : await mockRequest(message);
    options?.onResponse?.(response); return response;
  },
  getSnapshot: () => ({ url: "ws://runner/runner-ws", generation: 1, connectionOptionsGeneration: 0 }),
  subscribe: () => () => {},
} as unknown as RunnerWebSocketManager;

jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
}));
jest.mock("../utils/voiceOrchestratorIconPicker", () => ({
  supportsVoiceOrchestratorIconPicking: true,
  pickVoiceOrchestratorIcon: () => mockPickIcon(),
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../keyboardController", () => ({
  KeyboardAwareScrollView: require("react-native").ScrollView,
  KeyboardAvoidingView: require("react-native").View,
}));
jest.mock("./AppModal", () => ({
  AppModal: jest.fn(jest.requireActual("./AppModal").AppModal),
}));
jest.mock("./OrchestratorLearningPanel", () => ({
  OrchestratorLearningPanel: ({ orchestrator }: { orchestrator: { id: string } }) => {
    const ReactModule = require("react");
    return ReactModule.createElement(require("react-native").Text, null, `学習パネル: ${orchestrator.id}`);
  },
}));
jest.mock("./SettingsSelect", () => ({
  SettingsSelect: (props: { label: string;
    onSelect: (value: string) => void; onOpen?: () => void;
    searchValue?: string; onSearchChange?: (value: string) => void;
    options: { value: string }[] }) => {
    const ReactModule = require("react");
    if (mockRealSettingsSelect) return ReactModule.createElement(jest.requireActual("./SettingsSelect").SettingsSelect, props);
    const { label, onSelect, options, onOpen, searchValue, onSearchChange } = props;
    const { Pressable, Text } = require("react-native");
    return ReactModule.createElement(Pressable, { testID: `select-${label}`,
      accessibilityValue: { text: searchValue || "" },
      onLongPress: () => onSearchChange?.("old filter"),
      onPress: () => { onOpen?.(); onSelect(options[options.length - 1].value); } },
    ReactModule.createElement(Text, null, label));
  },
}));

const onListChanged = jest.fn();
const onConversationChanged = jest.fn();
const onClose = jest.fn();
const props = { visible: true, list, onConversationChanged, onClose };
let unsubscribe = () => {};

afterEach(() => unsubscribe());
beforeEach(() => { unsubscribe = subscribeVoiceOrchestrators(mockManager, onListChanged); jest.clearAllMocks(); mockLegacySettings = false; mockSaveFailure = false; mockMainInstruction = "Be helpful."; mockIsolationVersion = 1; mockRealSettingsSelect = false; });

test("opens through the platform modal and closes detail before the manager", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  const modalProps = () => jest.mocked(AppModal).mock.lastCall?.[0];
  expect(modalProps()).toEqual(expect.objectContaining({ visible: true, animationType: "slide",
    onRequestClose: expect.any(Function) }));
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await act(async () => { modalProps()?.onRequestClose?.(); });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId("orchestrator-row-other")).toBeTruthy();
  await act(async () => { modalProps()?.onRequestClose?.(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test("shows one fixed primary save button only while details are loaded", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  expect(screen.queryByTestId("orchestrator-save")).toBeNull();
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  const save = await screen.findByTestId("orchestrator-save");
  expect(within(screen.getByTestId("orchestrator-settings-scroll"))
    .queryByTestId("orchestrator-save")).toBeNull();
  expect(StyleSheet.flatten(save.props.style)).toMatchObject({ minHeight: 52, width: "100%" });
  await fireEvent.press(screen.getByLabelText("戻る"));
  expect(screen.queryByTestId("orchestrator-save")).toBeNull();
  await screen.unmount();
});

test("failed save shows its error beside the fixed button", async () => {
  mockSaveFailure = true;
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await screen.findByTestId("orchestrator-save");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(screen.getByText("保存エラー")).toBeTruthy());
  expect(within(screen.getByTestId("orchestrator-settings-scroll"))
    .queryByText("保存エラー")).toBeNull();
  expect(screen.getByTestId("orchestrator-save")).toBeTruthy();
  await screen.unmount();
});

test("list opens detail; name, uploaded icon, model, effort, and instructions save together", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.changeText(screen.getByTestId("orchestrator-name"), "新しい名前");
  await fireEvent.press(screen.getByLabelText("アイコン画像を選ぶ"));
  await waitFor(() => expect(mockPickIcon).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByTestId("select-モデル"));
  await fireEvent.press(screen.getByTestId("select-エフォート"));
  await fireEvent.press(screen.getByTestId("select-話題判定モデル"));
  await fireEvent.press(screen.getByTestId("select-話題判定エフォート"));
  await fireEvent.changeText(screen.getByTestId("orchestrator-system-instruction"), "Research carefully.");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.update",
    payload: { orchestratorId: "other", name: "新しい名前", icon, publicIntroduction: "", model: "another-model",
      ttsProvider: "aivisspeech", voiceId: "",
      effort: "high", systemInstruction: "Research carefully.",
      topicModel: "another-model", topicEffort: "high", overviewModel: "gpt-6-luna", overviewEffort: "low" } }));
  expect(onListChanged).toHaveBeenCalled();
  await screen.unmount();
});

test("selects a voice from the orchestrator's own provider catalog and saves it", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true,
    json: async () => ({ voices: [{ voiceId: "speaker-7", name: "声7" }] }) } as Response);
  const screen = await render(<VoiceOrchestratorManager {...props}
    runnerBaseUrl="https://runner.example" runnerToken="secret" />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("select-読み上げの声"));
  await fireEvent.press(screen.getByTestId("select-読み上げの声"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "https://runner.example/voices?ttsProvider=aivisspeech", expect.any(Object)));
  await waitFor(() => fireEvent.press(screen.getByTestId("select-読み上げの声")));
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.update",
    payload: expect.objectContaining({ orchestratorId: "other", ttsProvider: "aivisspeech",
      voiceId: "speaker-7" }) }));
  await screen.unmount();
});

test("opening another orchestrator clears the previous voice search", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("select-読み上げの声"));
  await fireEvent(screen.getByTestId("select-読み上げの声"), "longPress");
  expect(screen.getByTestId("select-読み上げの声").props.accessibilityValue.text).toBe("old filter");
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => expect(screen.getByTestId("select-読み上げの声").props.accessibilityValue.text).toBe(""));
  await screen.unmount();
});

test("new detail creates with full settings and main has no delete control", async () => {
  mockMainInstruction = "Main expert private instruction.";
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.getByTestId("orchestrator-system-instruction")).toHaveProp("value", mockMainInstruction);
  expect(screen.queryByTestId("orchestrator-delete")).toBeNull();
  expect(screen.getByTestId("select-To Do表示モデル")).toBeTruthy();
  expect(screen.getByTestId("select-To Do表示エフォート")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByTestId("orchestrator-add"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.getByTestId("orchestrator-system-instruction")).toHaveProp("value", "Be helpful.");
  expect(screen.getByTestId("select-To Do表示モデル")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("orchestrator-name"), "新規");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.create",
    payload: { name: "新規", icon: "", publicIntroduction: "", model: "gpt-6-luna", effort: "low",
      ttsProvider: "aivisspeech", voiceId: "",
      systemInstruction: "Be helpful.", topicModel: "gpt-6-luna", topicEffort: "low",
      overviewModel: "gpt-6-luna", overviewEffort: "low" } }));
  await screen.unmount();
});

test.each(["main", "other"])("%s saves independent To Do display model and effort", async (id) => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId(`orchestrator-row-${id}`));
  await waitFor(() => screen.getByTestId("select-To Do表示モデル"));
  await fireEvent.press(screen.getByTestId("select-To Do表示モデル"));
  await fireEvent.press(screen.getByTestId("select-To Do表示エフォート"));
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.update",
    payload: expect.objectContaining({ orchestratorId: id, overviewModel: "another-model",
      overviewEffort: "high" }) }));
  await screen.unmount();
});

test("older Runner settings remain editable without unsupported To Do display controls", async () => {
  mockLegacySettings = true;
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.queryByTestId("select-To Do表示モデル")).toBeNull();
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.update",
    payload: expect.not.objectContaining({ overviewModel: expect.anything() }) }));
  await screen.unmount();
});

test("per-orchestrator memory and messages clear through their own controls", async () => {
  const alerts = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.press(screen.getByLabelText("メモリーをクリア"));
  expect(alerts.mock.calls.at(-1)?.[1]).toBe("このオーケストレータの要約メモリーを消します。");
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.memory.clear",
    payload: { orchestratorId: "other" } }));
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(onConversationChanged).toHaveBeenCalledWith("other"));
  await screen.unmount();
  alerts.mockRestore();
});

test("an older Runner cannot clear shared memory through the isolated memory control", async () => {
  mockIsolationVersion = 0;
  const alerts = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.getByLabelText("メモリーをクリア")).toBeDisabled();
  await fireEvent.press(screen.getByLabelText("メモリーをクリア"));
  expect(alerts).not.toHaveBeenCalled();
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.memory.clear")).toBe(false);
  await screen.unmount();
  alerts.mockRestore();
});

test("a delayed memory clear never updates another orchestrator detail", async () => {
  let finish!: (value: Awaited<ReturnType<typeof mockRequest>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof mockRequest>>>((resolve) => { finish = resolve; });
  const alerts = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.press(screen.getByLabelText("メモリーをクリア"));
  mockRequest.mockImplementationOnce(async () => pending);
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await act(async () => {
    finish({ op: "voice.memory.clear.result", payload: { orchestratorId: "other", memoryCharacterCount: 0, storedMessageCount: 0 } });
    await pending;
  });
  expect(screen.getByText("12 文字 · このオーケストレータ専用")).toBeTruthy();
  expect(screen.queryByText("0 文字 · このオーケストレータ専用")).toBeNull();
  await screen.unmount();
  alerts.mockRestore();
});

test("deletion confirms and removes only a non-main orchestrator", async () => {
  const alerts = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-delete"));
  await fireEvent.press(screen.getByTestId("orchestrator-delete"));
  expect(alerts).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Array));
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.delete",
    payload: { orchestratorId: "other" } }));
  expect(onListChanged).toHaveBeenCalled();
  await screen.unmount();
  alerts.mockRestore();
});

test("selected orchestrator learning opens independently and back returns to the orchestrator list", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-learning-open"));
  expect(screen.getByText("学習パネル: main")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("select-オーケストレータ"));
  expect(screen.getByText("学習パネル: other")).toBeTruthy();
  expect(screen.queryByText("学習パネル: main")).toBeNull();
  expect(screen.queryByTestId("orchestrator-row-main")).toBeNull();
  expect(screen.queryByTestId("orchestrator-save")).toBeNull();
  await act(async () => { jest.mocked(AppModal).mock.lastCall?.[0].onRequestClose?.(); });
  expect(screen.getByTestId("orchestrator-row-main")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("a specialist detail opens only its own learning and returns to its detail", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.press(screen.getByLabelText("このオーケストレータの学習・評価を開く"));
  expect(screen.getByText("学習パネル: other")).toBeTruthy();
  await act(async () => { jest.mocked(AppModal).mock.lastCall?.[0].onRequestClose?.(); });
  expect(screen.getByTestId("orchestrator-name")).toHaveProp("value", "調査");
  await screen.unmount();
});


test("public introduction generation chooses a model and effort, leaves an editable draft, and only saves explicitly", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await screen.findByLabelText("得意分野・担当");
  await fireEvent.press(screen.getByLabelText("紹介を自動生成"));
  await fireEvent.press(screen.getByTestId("select-紹介のモデル"));
  await fireEvent.press(screen.getByTestId("select-紹介のエフォート"));
  await fireEvent.press(screen.getByLabelText("選んだモデルで紹介を生成"));
  await waitFor(() => expect(screen.getByLabelText("得意分野・担当").props.value).toBe("調査と実装の相談を担当します。"));
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.introduction.draft",
    payload: { orchestratorId: "other", model: "another-model", effort: "high" } }, { timeoutMs: 75_000 });
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.orchestrators.update")).toBe(false);
  await fireEvent.changeText(screen.getByLabelText("得意分野・担当"), "編集した紹介");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.orchestrators.update",
    payload: expect.objectContaining({ publicIntroduction: "編集した紹介", model: "gpt-6-luna", effort: "low", systemInstruction: "Be helpful." }) })));
});


test("closing settings dismisses the introduction picker before reopening", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await screen.findByLabelText("紹介を自動生成");
  await fireEvent.press(screen.getByLabelText("紹介を自動生成"));
  expect(screen.getByText("紹介の下書き")).toBeTruthy();
  await screen.rerender(<VoiceOrchestratorManager {...props} visible={false} />);
  await screen.rerender(<VoiceOrchestratorManager {...props} visible />);
  expect(screen.queryByText("紹介の下書き")).toBeNull();
});


test("introduction setup navigates inside the existing native modal and real model/effort selectors stay usable", async () => {
  mockRealSettingsSelect = true;
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await screen.findByLabelText("紹介を自動生成");
  await fireEvent.changeText(screen.getByLabelText("得意分野・担当"), "編集途中の紹介");
  const visibleModals = () => screen.container.queryAll((node) => node.type === "Modal" && node.props.visible === true);
  const managerModal = visibleModals()[0];
  expect(visibleModals()).toHaveLength(1);
  await fireEvent.press(screen.getByLabelText("紹介を自動生成"));
  expect(visibleModals()).toHaveLength(1);
  expect(visibleModals()[0]).toBe(managerModal);
  expect(within(managerModal).getByTestId("orchestrator-introduction-picker")).toBeTruthy();
  expect(screen.queryByTestId("orchestrator-save")).toBeNull();
  await fireEvent.press(screen.getByLabelText("紹介の生成をキャンセル"));
  expect(screen.getByLabelText("得意分野・担当").props.value).toBe("編集途中の紹介");
  await fireEvent.press(screen.getByLabelText("紹介を自動生成"));
  await act(async () => managerModal.props.onRequestClose());
  expect(screen.getByLabelText("得意分野・担当").props.value).toBe("編集途中の紹介");
  expect(onClose).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("紹介を自動生成"));
  await fireEvent.press(screen.getByLabelText("紹介のモデル"));
  expect(visibleModals()).toHaveLength(2);
  expect(within(managerModal).getByLabelText("紹介のモデルの選択肢")).toBeTruthy();
  await fireEvent.press(screen.getByText("Another"));
  expect(visibleModals()).toHaveLength(1);
  await fireEvent.press(screen.getByLabelText("紹介のエフォート"));
  await fireEvent.press(screen.getByText("高"));
  await fireEvent.press(screen.getByLabelText("選んだモデルで紹介を生成"));
  await waitFor(() => expect(screen.getByLabelText("得意分野・担当").props.value).toBe("調査と実装の相談を担当します。"));
  expect(mockRequest.mock.calls.filter(([message]) => message.op === "voice.orchestrators.introduction.draft")).toHaveLength(1);
  expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.introduction.draft",
    payload: { orchestratorId: "other", model: "another-model", effort: "high" } }, { timeoutMs: 75_000 });
  expect(mockRequest.mock.calls.some(([message]) => message.op === "voice.orchestrators.update")).toBe(false);
});
