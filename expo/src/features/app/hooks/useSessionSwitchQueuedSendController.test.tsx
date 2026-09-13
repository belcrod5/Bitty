import { act, renderHook } from "@testing-library/react-native";
import { useSessionSwitchQueuedSendController } from "./useSessionSwitchQueuedSendController";
import type { SessionSwitchQueuedSend } from "../types/appTypes";

test("preserves a Claude session snapshot while a restore queues and flushes a send", async () => {
  const queuedRef: { current: SessionSwitchQueuedSend | null } = { current: null };
  let resolveSend: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => { resolveSend = resolve; });
  const sendReplyRequest = jest.fn(async () => { resolveSend?.(); });
  const { result } = await renderHook(() => useSessionSwitchQueuedSendController({
    llmSessionRestoreInFlightRef: { current: true },
    llmSessionRestoreLoadingRef: { current: true },
    llmSessionRestoreRequestSeqRef: { current: 7 },
    sessionSwitchQueuedSendRef: queuedRef,
    transcript: "",
    setTranscript: jest.fn(),
    setReplyDebug: jest.fn(),
    showChatBottomToast: jest.fn(),
    shouldProjectQueuedSendDebug: () => false,
    sendReplyRequest,
  }));
  const sessionSnapshot = {
    backendId: "claude",
    sessionId: "session-claude",
    threadId: "native-claude",
    directory: "/workspace",
    directoryDisplayName: "Workspace",
    sessionTitle: "Claude session",
    modelRef: "sonnet",
    reasoningEffort: "",
    source: "agent",
  };

  await act(async () => {
    expect(result.current.queueSendReplyAfterSessionRestore("hello", {
      panelId: "panel-1",
      sessionSnapshot,
    })).toBe(true);
  });
  expect(queuedRef.current?.sessionSnapshot).toEqual(sessionSnapshot);

  await act(async () => {
    result.current.flushQueuedSendAfterSessionRestore(7, "native-claude");
    await sendStarted;
  });

  expect(sendReplyRequest).toHaveBeenCalledWith("hello", {
    inputDisposition: "clear",
    sttMeta: undefined,
    panelId: "panel-1",
    sessionSnapshot,
  });
});

test("preserves queued compact input and its acceptance callback through flush", async () => {
  const queuedRef: { current: SessionSwitchQueuedSend | null } = { current: null };
  const setTranscript = jest.fn();
  const onAccepted = jest.fn();
  let resolveSend: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => { resolveSend = resolve; });
  const sendReplyRequest = jest.fn(async () => { resolveSend?.(); });
  const { result } = await renderHook(() => useSessionSwitchQueuedSendController({
    llmSessionRestoreInFlightRef: { current: true },
    llmSessionRestoreLoadingRef: { current: true },
    llmSessionRestoreRequestSeqRef: { current: 8 },
    sessionSwitchQueuedSendRef: queuedRef,
    transcript: "/compact",
    setTranscript,
    setReplyDebug: jest.fn(),
    showChatBottomToast: jest.fn(),
    shouldProjectQueuedSendDebug: () => false,
    sendReplyRequest,
  }));

  expect(result.current.queueSendReplyAfterSessionRestore(undefined, {
    panelId: "panel-1",
    onAccepted,
  })).toBe(true);
  expect(queuedRef.current?.inputDisposition).toBe("preserve");
  expect(setTranscript).not.toHaveBeenCalled();
  expect(onAccepted).not.toHaveBeenCalled();

  result.current.flushQueuedSendAfterSessionRestore(8, "thread-1");
  await sendStarted;

  expect(sendReplyRequest).toHaveBeenCalledWith("/compact", {
    inputDisposition: "preserve",
    sttMeta: undefined,
    panelId: "panel-1",
    sessionSnapshot: undefined,
  });
  expect(onAccepted).not.toHaveBeenCalled();
});

test("clears a normal queued send when the queue accepts it", async () => {
  const queuedRef: { current: SessionSwitchQueuedSend | null } = { current: null };
  const setTranscript = jest.fn();
  const onAccepted = jest.fn();
  const { result } = await renderHook(() => useSessionSwitchQueuedSendController({
    llmSessionRestoreInFlightRef: { current: true },
    llmSessionRestoreLoadingRef: { current: true },
    llmSessionRestoreRequestSeqRef: { current: 9 },
    sessionSwitchQueuedSendRef: queuedRef,
    transcript: "hello",
    setTranscript,
    setReplyDebug: jest.fn(),
    showChatBottomToast: jest.fn(),
    shouldProjectQueuedSendDebug: () => false,
    sendReplyRequest: jest.fn(async () => {}),
  }));

  expect(result.current.queueSendReplyAfterSessionRestore(undefined, {
    panelId: "panel-1",
    onAccepted,
  })).toBe(true);
  expect(queuedRef.current?.inputDisposition).toBe("clear");
  expect(setTranscript).toHaveBeenCalledWith("");
  expect(onAccepted).toHaveBeenCalledTimes(1);
});
