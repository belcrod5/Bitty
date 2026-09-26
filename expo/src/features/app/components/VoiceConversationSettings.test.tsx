import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { VoiceConversationSettings } from "./VoiceConversationSettings";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const mockManager = {
  connect: jest.fn(async () => undefined),
  request: jest.fn(),
  getSnapshot: jest.fn(() => ({ connected: true, generation: 1 })),
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => ({ connected: true, generation: 1 }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockManager.request.mockImplementation(async ({ op, payload }: { op: string; payload?: Record<string, string> }) => ({
    op: `${op}.result`,
    payload: op === "voice.settings" ? {
      model: "gpt-6-luna", effort: "low", models: [
        { modelId: "gpt-6-luna", label: "Luna", effortOptions: ["low"] },
        { modelId: "another-model", label: "Another", effortOptions: ["medium", "high"] },
      ],
      storedMessageCount: 7, memoryCharacterCount: 42,
    } : op === "voice.memory.clear" ? {
      storedMessageCount: 7, memoryCharacterCount: 0,
    } : op === "voice.messages.clear" ? {
      storedMessageCount: 0, memoryCharacterCount: 0,
    } : payload || {},
  }));
});

test("selects a catalog model with a supported effort", async () => {
  const screen = await render(<VoiceConversationSettings />);
  await waitFor(() => expect(screen.getByText("Luna")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("音声会話のモデル"));
  await fireEvent.press(screen.getByText("Another"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({
    channel: "agent", op: "voice.settings.update", payload: { model: "another-model", effort: "medium" },
  }));
  await waitFor(() => expect(screen.getByText("中")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("音声会話のエフォート"));
  await fireEvent.press(screen.getByText("高"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({
    channel: "agent", op: "voice.settings.update", payload: { model: "another-model", effort: "high" },
  }));
});

test("confirms each clear action and calls its separate Runner operation", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.text === "クリア")?.onPress?.();
  });
  const screen = await render(<VoiceConversationSettings />);
  await waitFor(() => expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy());
  expect(screen.getByText("保存中: 42文字 · 保持メッセージから再生成される場合があります")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("メモリーをクリア"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.memory.clear" }));
  await waitFor(() => expect(screen.getByText("保存中: 0文字 · 保持メッセージから再生成される場合があります")).toBeTruthy());
  expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText("保持メッセージをクリア").props.accessibilityState?.disabled).toBe(false));
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.messages.clear" }));
  await waitFor(() => expect(screen.getByText("保存中: 0件 · 要約メモリーは残します")).toBeTruthy());
  expect(alert).toHaveBeenCalledTimes(2);
  alert.mockRestore();
});

test("keeps the last confirmed counts when clear fails", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.text === "クリア")?.onPress?.();
  });
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.messages.clear") throw new Error("connection lost");
    return { op: `${op}.result`, payload: {
      model: "gpt-6-luna", effort: "low", models: [], storedMessageCount: 7, memoryCharacterCount: 42,
    } };
  });
  const screen = await render(<VoiceConversationSettings />);
  await waitFor(() => expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await waitFor(() => expect(screen.getByText("connection lost")).toBeTruthy());
  expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy();
  expect(screen.getByText("保存中: 42文字 · 保持メッセージから再生成される場合があります")).toBeTruthy();
  alert.mockRestore();
});

test("waits for settings before enabling clears or showing saved counts", async () => {
  let resolveSettings!: (response: unknown) => void;
  mockManager.request.mockImplementation(() => new Promise((resolve) => { resolveSettings = resolve; }));
  const screen = await render(<VoiceConversationSettings />);
  expect(screen.getByLabelText("メモリーをクリア").props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByLabelText("保持メッセージをクリア").props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByText("保存中: --件 · 要約メモリーは残します")).toBeTruthy();
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.settings" }));
  await act(async () => {
    resolveSettings({ op: "voice.settings.result", payload: {
      model: "gpt-6-luna", effort: "low", models: [], storedMessageCount: 7, memoryCharacterCount: 42,
    } });
  });
  await waitFor(() => expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy());
  expect(screen.getByLabelText("保持メッセージをクリア").props.accessibilityState?.disabled).toBe(false);
});

test("message clear updates its count while preserving the memory count", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.text === "クリア")?.onPress?.();
  });
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => ({
    op: `${op}.result`, payload: op === "voice.messages.clear"
      ? { storedMessageCount: 0, memoryCharacterCount: 42 }
      : { model: "gpt-6-luna", effort: "low", models: [], storedMessageCount: 7, memoryCharacterCount: 42 },
  }));
  const screen = await render(<VoiceConversationSettings />);
  await waitFor(() => expect(screen.getByText("保存中: 7件 · 要約メモリーは残します")).toBeTruthy());
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await waitFor(() => expect(screen.getByText("保存中: 0件 · 要約メモリーは残します")).toBeTruthy());
  expect(screen.getByText("保存中: 42文字 · 保持メッセージから再生成される場合があります")).toBeTruthy();
  alert.mockRestore();
});
