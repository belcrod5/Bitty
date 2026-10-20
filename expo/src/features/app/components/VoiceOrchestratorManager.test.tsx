import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Alert, StyleSheet } from "react-native";
import { AppModal } from "./AppModal";
import { VoiceOrchestratorManager } from "./VoiceOrchestratorManager";

const icon = "data:image/png;base64,iVBORw0KGgo=";
let mockLegacySettings = false;
let mockSaveFailure = false;
const mockPickIcon = jest.fn(async () => icon);
const mockRequest = jest.fn(async (message: { op: string; payload?: Record<string, unknown> }) => {
  const { op, payload } = message;
  if (op === "voice.settings") return { op: `${op}.result`, payload: {
    orchestratorId: payload?.orchestratorId,
    name: payload?.orchestratorId === "main" ? "メイン" : "調査",
    icon: "", model: "gpt-6-luna", effort: "low", systemInstruction: "Be helpful.",
    ttsProvider: "aivisspeech", voiceId: "",
    topicModel: "gpt-6-luna", topicEffort: "low",
    ...(!mockLegacySettings
      ? { overviewModel: "gpt-6-luna", overviewEffort: "low" } : {}),
    models: [
      { modelId: "gpt-6-luna", label: "Luna", effortOptions: ["low"] },
      { modelId: "another-model", label: "Another", effortOptions: ["medium", "high"] },
    ], storedMessageCount: 2, memoryCharacterCount: 12,
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
const mockManager = { request: mockRequest };

jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
}));
jest.mock("../utils/voiceOrchestratorIconPicker", () => ({
  supportsVoiceOrchestratorIconPicking: true,
  pickVoiceOrchestratorIcon: () => mockPickIcon(),
}));
jest.mock("../keyboardController", () => ({
  KeyboardAwareScrollView: require("react-native").ScrollView,
  KeyboardAvoidingView: require("react-native").View,
}));
jest.mock("./AppModal", () => ({
  AppModal: jest.fn(({ children }: { children: ReactNode }) => children),
}));
jest.mock("./OrchestratorLearningPanel", () => ({
  OrchestratorLearningPanel: () => {
    const ReactModule = require("react");
    return ReactModule.createElement(require("react-native").Text, null, "共有学習パネル");
  },
}));
jest.mock("./SettingsSelect", () => ({
  SettingsSelect: ({ label, onSelect, options, onOpen, searchValue, onSearchChange }: { label: string;
    onSelect: (value: string) => void; onOpen?: () => void;
    searchValue?: string; onSearchChange?: (value: string) => void;
    options: { value: string }[] }) => {
    const ReactModule = require("react");
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
const props = { visible: true, list, onListChanged, onConversationChanged, onClose };

beforeEach(() => { jest.clearAllMocks(); mockLegacySettings = false; mockSaveFailure = false; });

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
    payload: { orchestratorId: "other", name: "新しい名前", icon, model: "another-model",
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
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.queryByTestId("orchestrator-delete")).toBeNull();
  expect(screen.getByTestId("select-To Do表示モデル")).toBeTruthy();
  expect(screen.getByTestId("select-To Do表示エフォート")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByTestId("orchestrator-add"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.getByTestId("select-To Do表示モデル")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("orchestrator-name"), "新規");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.create",
    payload: { name: "新規", icon: "", model: "gpt-6-luna", effort: "low",
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

test("shared memory and per-orchestrator messages clear through their own controls", async () => {
  const alerts = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.press(screen.getByLabelText("共有メモリーをクリア"));
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.memory.clear",
    payload: { orchestratorId: "other" } }));
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await act(async () => { alerts.mock.calls.at(-1)?.[2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(onConversationChanged).toHaveBeenCalledWith("other"));
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

test("shared learning opens independently and back returns to the orchestrator list", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-learning-open"));
  expect(screen.getByText("共有学習パネル")).toBeTruthy();
  expect(screen.queryByTestId("orchestrator-row-main")).toBeNull();
  expect(screen.queryByTestId("orchestrator-save")).toBeNull();
  await act(async () => { jest.mocked(AppModal).mock.lastCall?.[0].onRequestClose?.(); });
  expect(screen.getByTestId("orchestrator-row-main")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  await screen.unmount();
});
