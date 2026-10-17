import { act, renderHook } from "@testing-library/react-native";
import type { TtsPlaybackTarget } from "../types/appTypes";
import { useSessionSwitchQuiesceController } from "./useSessionSwitchQuiesceController";

function createOptions(target: TtsPlaybackTarget) {
  return {
    suspendCodexTurnRequestForSessionSwitch: jest.fn(),
    closeCodexRelayObserver: jest.fn(),
    stopTtsPlayback: jest.fn(async () => undefined),
    ttsPlaybackProjectionTargetRef: { current: target },
    setStreamMode: jest.fn(),
    setStreamLlmNativeDeltaCount: jest.fn(),
    setStreamLlmPseudoDeltaCount: jest.fn(),
    setStreamFirstNativeDeltaOffsetMs: jest.fn(),
    setStreamLlmDeltas: jest.fn(),
    setStreamLlmProgress: jest.fn(),
    setStreamSegments: jest.fn(),
    setStreamReplyYouTubeVideoIdsWithRef: jest.fn(),
    setTtsPlaybackMessageIdWithRef: jest.fn(),
    setReply: jest.fn(),
    replyLoadingRef: { current: true },
    setReplyLoadingWithRef: jest.fn(),
    finishLlmRequest: jest.fn(),
    setReplyDebug: jest.fn(),
  };
}

test.each(["voice-start-announcement", "reply-operation"])(
  "restoring a chat preserves independent voice playback: %s", async (messageId) => {
    const options = createOptions({ scope: "voice", messageId });
    const { result } = await renderHook(() => useSessionSwitchQuiesceController(options));

    await act(async () => { await result.current.quiesceForSessionSwitch("select_specific_session"); });

    expect(options.stopTtsPlayback).not.toHaveBeenCalled();
    expect(options.setStreamMode).not.toHaveBeenCalled();
    expect(options.setStreamSegments).not.toHaveBeenCalled();
    expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
    expect(options.suspendCodexTurnRequestForSessionSwitch).toHaveBeenCalledTimes(1);
    expect(options.closeCodexRelayObserver).toHaveBeenCalledWith("session_switch:select_specific_session");
    expect(options.setReply).toHaveBeenCalledWith("");
    expect(options.setReplyLoadingWithRef).toHaveBeenCalledWith(false);
    expect(options.finishLlmRequest).toHaveBeenCalledWith("idle", "session_switch");
  },
);

test.each<TtsPlaybackTarget>([{ scope: "chat", messageId: "chat-message" }, {}])(
  "chat-owned and unscoped playback still stop during a session switch: %j", async (target) => {
    const options = createOptions(target);
    const { result } = await renderHook(() => useSessionSwitchQuiesceController(options));

    await act(async () => { await result.current.quiesceForSessionSwitch("select_specific_session"); });

    expect(options.stopTtsPlayback).toHaveBeenCalledWith({
      interruptStream: true, reason: "session_switch:select_specific_session",
    });
    expect(options.setStreamMode).toHaveBeenCalledWith("");
    expect(options.setStreamSegments).toHaveBeenCalledWith([]);
    expect(options.setTtsPlaybackMessageIdWithRef).toHaveBeenCalledWith("");
  },
);

test("a delayed chat stop cannot clear the voice playback that takes over while it settles", async () => {
  const options = createOptions({ scope: "chat", messageId: "chat-message" });
  let finishStop!: () => void;
  options.stopTtsPlayback.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
    finishStop = () => resolve(undefined);
  }));
  const { result } = await renderHook(() => useSessionSwitchQuiesceController(options));
  let quiesce!: Promise<void>;
  await act(async () => { quiesce = result.current.quiesceForSessionSwitch("select_specific_session"); });
  options.ttsPlaybackProjectionTargetRef.current = { scope: "voice", messageId: "voice-start-announcement" };
  await act(async () => { finishStop(); await quiesce; });

  expect(options.setStreamMode).not.toHaveBeenCalled();
  expect(options.setStreamSegments).not.toHaveBeenCalled();
  expect(options.setTtsPlaybackMessageIdWithRef).not.toHaveBeenCalled();
  expect(options.setReply).toHaveBeenCalledWith("");
  expect(options.finishLlmRequest).toHaveBeenCalledWith("idle", "session_switch");
});

test("resume sync preserves the live observer and voice playback while resetting chat state", async () => {
  const options = createOptions({ scope: "voice", messageId: "voice-start-announcement" });
  const { result } = await renderHook(() => useSessionSwitchQuiesceController(options));
  await act(async () => {
    await result.current.quiesceForSessionSwitch("select_specific_session", { preserveRelayObserver: true });
  });

  expect(options.closeCodexRelayObserver).not.toHaveBeenCalled();
  expect(options.stopTtsPlayback).not.toHaveBeenCalled();
  expect(options.setStreamLlmDeltas).toHaveBeenCalledWith([]);
  expect(options.setStreamLlmProgress).toHaveBeenCalledWith([]);
  expect(options.finishLlmRequest).toHaveBeenCalledWith("idle", "session_switch");
});
