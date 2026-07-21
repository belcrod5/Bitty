import { act, renderHook } from "@testing-library/react-native";
import { useSessionSwitchQueuedSendController } from "./useSessionSwitchQueuedSendController";

function createHarness() {
  const sessionSwitchQueuedSendRef = { current: null };
  const showChatBottomToast = jest.fn();
  const options = {
    llmSessionRestoreInFlightRef: { current: true },
    llmSessionRestoreLoadingRef: { current: false },
    llmSessionRestoreRequestSeqRef: { current: 7 },
    sessionSwitchQueuedSendRef,
    transcript: "",
    setTranscript: jest.fn(),
    setReplyDebug: jest.fn(),
    showChatBottomToast,
    shouldProjectQueuedSendDebug: () => false,
    sendReplyRequest: jest.fn(async () => {}),
  };

  return { options, sessionSwitchQueuedSendRef, showChatBottomToast };
}

describe("useSessionSwitchQueuedSendController", () => {
  it("does not queue a panel-scoped send behind an unrelated main session restore", async () => {
    const harness = createHarness();
    const { result } = await renderHook(() => useSessionSwitchQueuedSendController(harness.options));

    let queued = true;
    await act(async () => {
      queued = result.current.queueSendReplyAfterSessionRestore("hello", {
        panelId: "drawer-session-popup",
      });
    });

    expect(queued).toBe(false);
    expect(harness.sessionSwitchQueuedSendRef.current).toBeNull();
    expect(harness.showChatBottomToast).not.toHaveBeenCalled();
  });

  it("keeps a main send queued while the main session is restoring", async () => {
    const harness = createHarness();
    const { result } = await renderHook(() => useSessionSwitchQueuedSendController(harness.options));

    let queued = false;
    await act(async () => {
      queued = result.current.queueSendReplyAfterSessionRestore("hello", { panelId: "main" });
    });

    expect(queued).toBe(true);
    expect(harness.sessionSwitchQueuedSendRef.current).toMatchObject({
      transcript: "hello",
      panelId: "main",
      restoreRequestSeq: 7,
    });
    expect(harness.showChatBottomToast).toHaveBeenCalledWith(
      "user",
      "セッション切替完了後に自動送信します"
    );
  });
});
