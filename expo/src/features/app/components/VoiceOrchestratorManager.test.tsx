import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Alert } from "react-native";
import { AppModal } from "./AppModal";
import { VoiceOrchestratorManager } from "./VoiceOrchestratorManager";

const icon = "data:image/png;base64,iVBORw0KGgo=";
const mockPickIcon = jest.fn(async () => icon);
const mockRequest = jest.fn(async (message: { op: string; payload?: Record<string, unknown> }) => {
  const { op, payload } = message;
  if (op === "voice.settings") return { op: `${op}.result`, payload: {
    orchestratorId: payload?.orchestratorId,
    name: payload?.orchestratorId === "main" ? "メイン" : "調査",
    icon: "", model: "gpt-6-luna", effort: "low", systemInstruction: "Be helpful.",
    models: [
      { modelId: "gpt-6-luna", label: "Luna", effortOptions: ["low"] },
      { modelId: "another-model", label: "Another", effortOptions: ["medium", "high"] },
    ], storedMessageCount: 2, memoryCharacterCount: 12,
  } };
  if (op === "voice.orchestrators.create") return { op: `${op}.result`, payload: {
    orchestrators: [...list.orchestrators, { id: "new-id", name: payload?.name, icon: payload?.icon }],
    selectedId: "main",
  } };
  if (op === "voice.orchestrators.update") return { op: `${op}.result`, payload: {
    orchestrators: list.orchestrators.map((item) => item.id === payload?.orchestratorId
      ? { ...item, name: payload.name, icon: payload.icon } : item), selectedId: "main",
  } };
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
}));
jest.mock("./AppModal", () => ({
  AppModal: jest.fn(({ children }: { children: ReactNode }) => children),
}));
jest.mock("./SettingsSelect", () => ({
  SettingsSelect: ({ label, onSelect, options }: { label: string; onSelect: (value: string) => void;
    options: { value: string }[] }) => {
    const ReactModule = require("react");
    const { Pressable, Text } = require("react-native");
    return ReactModule.createElement(Pressable, { testID: `select-${label}`,
      onPress: () => onSelect(options[options.length - 1].value) }, ReactModule.createElement(Text, null, label));
  },
}));

const onListChanged = jest.fn();
const onConversationChanged = jest.fn();
const onClose = jest.fn();
const props = { visible: true, list, onListChanged, onConversationChanged, onClose };

beforeEach(() => { jest.clearAllMocks(); });

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

test("list opens detail; name, uploaded icon, model, effort, and instructions save together", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-other"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.changeText(screen.getByTestId("orchestrator-name"), "新しい名前");
  await fireEvent.press(screen.getByLabelText("アイコン画像を選ぶ"));
  await waitFor(() => expect(mockPickIcon).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByTestId("select-モデル"));
  await fireEvent.press(screen.getByTestId("select-エフォート"));
  await fireEvent.changeText(screen.getByTestId("orchestrator-system-instruction"), "Research carefully.");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.update",
    payload: { orchestratorId: "other", name: "新しい名前", icon, model: "another-model",
      effort: "high", systemInstruction: "Research carefully." } }));
  expect(onListChanged).toHaveBeenCalled();
  await screen.unmount();
});

test("new detail creates with full settings and main has no delete control", async () => {
  const screen = await render(<VoiceOrchestratorManager {...props} />);
  await fireEvent.press(screen.getByTestId("orchestrator-row-main"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  expect(screen.queryByTestId("orchestrator-delete")).toBeNull();
  await fireEvent.press(screen.getByLabelText("戻る"));
  await fireEvent.press(screen.getByTestId("orchestrator-add"));
  await waitFor(() => screen.getByTestId("orchestrator-name"));
  await fireEvent.changeText(screen.getByTestId("orchestrator-name"), "新規");
  await fireEvent.press(screen.getByTestId("orchestrator-save"));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.create",
    payload: { name: "新規", icon: "", model: "gpt-6-luna", effort: "low",
      systemInstruction: "Be helpful." } }));
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
