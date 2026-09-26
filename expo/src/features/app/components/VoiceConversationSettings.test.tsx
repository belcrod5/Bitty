import { Alert } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { VoiceConversationSettings } from "./VoiceConversationSettings";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const mockManager = {
  connect: jest.fn(async () => undefined),
  request: jest.fn(),
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
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.settings" }));
  await fireEvent.press(screen.getByLabelText("メモリーをクリア"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.memory.clear" }));
  await waitFor(() => expect(screen.getByLabelText("保持メッセージをクリア").props.accessibilityState?.disabled).toBe(false));
  await fireEvent.press(screen.getByLabelText("保持メッセージをクリア"));
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.messages.clear" }));
  expect(alert).toHaveBeenCalledTimes(2);
  alert.mockRestore();
});
