import { renderHook } from "@testing-library/react-native";
import type { ConversationMessage } from "../types/appTypes";
import { useReplyAudioFlowController } from "./useReplyAudioFlowController";

const message = {
  id: "message-1",
  role: "assistant",
  content: "private reply text",
} as ConversationMessage;

test("plays a completed message from its session independently of other replies", async () => {
  const logAuto = jest.fn();
  const synthesizeSpeechStream = jest.fn(async () => {});
  const otherSessionReplyLoadingRef = { current: true };
  const options = {
    // The former global guard rejected this press while another session was responding.
    replyLoadingRef: otherSessionReplyLoadingRef,
    ttsPlayingRef: { current: false },
    ttsPlaybackMessageId: "",
    ttsLoading: false,
    stopWaveformPlayback: jest.fn(async () => {}),
    synthesizeSpeechStream,
    logAuto,
  };
  const { result } = await renderHook(() => useReplyAudioFlowController(options));

  await result.current.handleAssistantAudioButtonPress(message, {
    panelId: "drawer_session_popup",
    sessionId: "completed-session",
  });

  expect(synthesizeSpeechStream).toHaveBeenCalledWith("private reply text", {
    panelId: "drawer_session_popup",
    sessionId: "completed-session",
    messageId: "message-1",
  });
  expect(logAuto).toHaveBeenCalledWith("tts_trace", {
    stage: "button_synthesize", messageId: "message-1",
  });
  expect(otherSessionReplyLoadingRef.current).toBe(true);
  expect(JSON.stringify(logAuto.mock.calls)).not.toContain("private reply text");
});

test("pressing the playing message stops it", async () => {
  const stopWaveformPlayback = jest.fn(async () => {});
  const synthesizeSpeechStream = jest.fn(async () => {});
  const options = {
    replyLoadingRef: { current: true },
    ttsPlayingRef: { current: true },
    ttsPlaybackMessageId: message.id,
    ttsLoading: false,
    stopWaveformPlayback,
    synthesizeSpeechStream,
    logAuto: jest.fn(),
  };
  const { result } = await renderHook(() => useReplyAudioFlowController(options));

  await result.current.handleAssistantAudioButtonPress(message, {
    sessionId: "completed-session",
  });

  expect(stopWaveformPlayback).toHaveBeenCalledTimes(1);
  expect(synthesizeSpeechStream).not.toHaveBeenCalled();
});

test("switches playback while another reply is running", async () => {
  let finishStop: () => void = () => {};
  const options = {
    replyLoadingRef: { current: true },
    ttsPlayingRef: { current: true },
    ttsPlaybackMessageId: "previous-message",
    ttsLoading: false,
    stopWaveformPlayback: jest.fn(() => new Promise<void>((resolve) => { finishStop = resolve; })),
    synthesizeSpeechStream: jest.fn(async () => {}),
    logAuto: jest.fn(),
  };
  const { result } = await renderHook(() => useReplyAudioFlowController(options));

  const press = result.current.handleAssistantAudioButtonPress(message, {
    sessionId: "completed-session",
  });
  expect(options.stopWaveformPlayback).toHaveBeenCalledTimes(1);
  expect(options.synthesizeSpeechStream).not.toHaveBeenCalled();
  finishStop();
  await press;

  expect(options.synthesizeSpeechStream).toHaveBeenCalledWith("private reply text", {
    sessionId: "completed-session",
    messageId: "message-1",
  });
});
