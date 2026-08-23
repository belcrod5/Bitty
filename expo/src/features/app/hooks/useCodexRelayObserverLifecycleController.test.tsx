import { act, renderHook } from "@testing-library/react-native";
import { useCodexRelayObserverLifecycleController } from "./useCodexRelayObserverLifecycleController";

test("observer stop is scoped to the requested panel and thread", async () => {
  const interrupt = jest.fn(async () => {});
  const observerRef = {
    current: {
      threadId: "thread-1",
      panelId: "panel-1",
      close: jest.fn(),
      interrupt,
    },
  };
  const { result } = await renderHook(() => useCodexRelayObserverLifecycleController({
    codexRelayObserverRef: observerRef,
    codexRelayObserverReplyByThreadRef: { current: {} },
    codexRelayObserverStartedAtMsByThreadRef: { current: {} },
    finishWaitingApprovalResumeAttempt: jest.fn(() => false),
    setWaitingApprovalResumeStatusText: jest.fn(),
    logSessionDiag: jest.fn(),
  }));

  let wrongPanel = true;
  let wrongThread = true;
  let matched = false;
  await act(async () => {
    wrongPanel = await result.current.interruptCodexRelayObserver({
      panelId: "panel-2",
      threadId: "thread-1",
    });
    wrongThread = await result.current.interruptCodexRelayObserver({
      panelId: "panel-1",
      threadId: "thread-2",
    });
    matched = await result.current.interruptCodexRelayObserver({
      panelId: "panel-1",
      threadId: "thread-1",
    });
  });

  expect(wrongPanel).toBe(false);
  expect(wrongThread).toBe(false);
  expect(matched).toBe(true);
  expect(interrupt).toHaveBeenCalledTimes(1);
});
