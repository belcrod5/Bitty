import { act, renderHook } from "@testing-library/react-native";
import { useSendReplyRequestController } from "./useSendReplyRequestController";
import type { SendReplyRequestResult } from "./useCodexReplyRequest";

function createArgs(sendResult: SendReplyRequestResult) {
  return {
    queueSendReplyAfterSessionRestore: jest.fn(() => false),
    showChatBottomToast: jest.fn(),
    normalizedLlmDirectoryForRequest: jest.fn(() => ""),
    closeCodexRelayObserver: jest.fn(),
    interruptCodexRelayObserver: jest.fn(async () => true),
    resolvePanelSessionSnapshot: jest.fn(() => ({ sessionId: "session-1", threadId: "thread-1" })),
    logSessionDiag: jest.fn(),
    sendReplyRequestFromCodex: jest.fn(async () => sendResult),
    cancelReplyRequestFromCodex: jest.fn(async () => true),
    suspendReplyRequestFromCodex: jest.fn(() => true),
  };
}

const sendOptions = {
  panelId: "panel-1",
  sessionSnapshot: { sessionId: "session-1", threadId: "thread-1", directory: "/tmp" },
};

describe("useSendReplyRequestController rejection feedback", () => {
  test.each(["active_request", "model_unavailable"] as const)("surfaces %s rejection as a toast (no silent skip)", async (reason) => {
    const args = createArgs({ rejected: reason });
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("hello", sendOptions);
    });

    expect(args.sendReplyRequestFromCodex).toHaveBeenCalledTimes(1);
    expect(args.showChatBottomToast).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("送信できませんでした")
    );
    expect(args.logSessionDiag).toHaveBeenCalledWith(
      "reply_send_guard_rejected",
      expect.objectContaining({ reason }),
      expect.anything()
    );
  });

  test("empty transcript rejection stays quiet (send button is disabled for empty input)", async () => {
    const args = createArgs({ rejected: "empty_transcript" });
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("", sendOptions);
    });

    expect(args.showChatBottomToast).not.toHaveBeenCalled();
  });

  test("accepted send shows no rejection feedback", async () => {
    const args = createArgs(undefined);
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("hello", sendOptions);
    });

    expect(args.sendReplyRequestFromCodex).toHaveBeenCalledTimes(1);
    expect(args.showChatBottomToast).not.toHaveBeenCalled();
  });

  test("notifies acceptance immediately when a send is queued for session restore", async () => {
    const args = createArgs(undefined);
    args.queueSendReplyAfterSessionRestore.mockReturnValue(true);
    const onAccepted = jest.fn();
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("hello", { ...sendOptions, onAccepted });
    });

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(args.sendReplyRequestFromCodex).not.toHaveBeenCalled();
  });

  test("does not notify acceptance for a rejected send", async () => {
    const args = createArgs({ rejected: "active_request" });
    const onAccepted = jest.fn();
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("hello", { ...sendOptions, onAccepted });
    });

    expect(onAccepted).not.toHaveBeenCalled();
  });

  test("preserves the saved backend through the guarded send", async () => {
    const args = createArgs(undefined);
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.sendReplyRequestWithSessionGuard("hello", {
        ...sendOptions,
        sessionSnapshot: { ...sendOptions.sessionSnapshot, backendId: "claude" },
      });
    });

    expect(args.sendReplyRequestFromCodex).toHaveBeenCalledWith("hello", expect.objectContaining({
      sessionSnapshot: expect.objectContaining({ backendId: "claude" }),
    }));
  });

  test("stops a restored observer when no locally-owned turn remains", async () => {
    const args = createArgs(undefined);
    args.cancelReplyRequestFromCodex.mockResolvedValue(false);
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.cancelCodexTurnRequestGuarded({ panelId: "panel-1" });
    });

    expect(args.interruptCodexRelayObserver).toHaveBeenCalledWith({
      panelId: "panel-1",
      threadId: "thread-1",
    });
  });

  test("does not stop a different session when the target panel has no session", async () => {
    const args = createArgs(undefined);
    args.cancelReplyRequestFromCodex.mockResolvedValue(false);
    (args.resolvePanelSessionSnapshot as jest.Mock).mockReturnValue(undefined);
    const { result } = await renderHook(() => useSendReplyRequestController(args));

    await act(async () => {
      await result.current.cancelCodexTurnRequestGuarded({ panelId: "panel-2" });
    });

    expect(args.interruptCodexRelayObserver).not.toHaveBeenCalled();
  });
});
