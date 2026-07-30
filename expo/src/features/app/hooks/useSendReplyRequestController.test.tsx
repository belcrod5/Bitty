import { act, renderHook } from "@testing-library/react-native";
import { useSendReplyRequestController } from "./useSendReplyRequestController";
import type { SendReplyRequestResult } from "./useCodexReplyRequest";

function createArgs(sendResult: SendReplyRequestResult) {
  return {
    queueSendReplyAfterSessionRestore: jest.fn(() => false),
    showChatBottomToast: jest.fn(),
    normalizedLlmDirectoryForRequest: jest.fn(() => ""),
    closeCodexRelayObserver: jest.fn(),
    logSessionDiag: jest.fn(),
    sendReplyRequestFromCodex: jest.fn(async () => sendResult),
    llmBackend: "codex_app_server",
    cancelReplyRequestFromCodex: jest.fn(async () => true),
    suspendReplyRequestFromCodex: jest.fn(() => true),
  };
}

const sendOptions = {
  panelId: "panel-1",
  sessionSnapshot: { sessionId: "session-1", threadId: "thread-1", directory: "/tmp" },
};

describe("useSendReplyRequestController rejection feedback", () => {
  test("surfaces a gate-blocked rejection as a toast (no silent skip)", async () => {
    const args = createArgs({ rejected: "active_request" });
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
      expect.objectContaining({ reason: "active_request" }),
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
});
