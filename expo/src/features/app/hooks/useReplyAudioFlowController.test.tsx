import { renderHook } from "@testing-library/react-native";
import type { ConversationMessage } from "../types/appTypes";
import { useReplyAudioFlowController } from "./useReplyAudioFlowController";

test("traces a blocked audio button press without logging reply text", async () => {
  const logAuto = jest.fn();
  const synthesizeSpeechStream = jest.fn(async () => {});
  const message = { id: "message-1", role: "assistant", content: "private reply text" } as ConversationMessage;
  const { result } = await renderHook(() => useReplyAudioFlowController({
    nearUnlimitedTimeoutMs: 1000,
    replyLoadingRef: { current: true },
    ttsPlayingRef: { current: false },
    ttsPlaybackMessageId: "",
    ttsLoading: false,
    stopWaveformPlayback: jest.fn(async () => {}),
    synthesizeSpeechStream,
    logAuto,
  }));

  await result.current.handleAssistantAudioButtonPress(message);

  expect(synthesizeSpeechStream).not.toHaveBeenCalled();
  expect(logAuto).toHaveBeenCalledWith("tts_trace", {
    stage: "button_ignored", reason: "reply_loading", messageId: "message-1",
  });
  expect(JSON.stringify(logAuto.mock.calls)).not.toContain("private reply text");
});
