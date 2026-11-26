import { act, renderHook } from "@testing-library/react-native";
import { useChatScrollNavigation } from "./useChatScrollNavigation";

it("scrolls to the original message's visual index when browser cards are interleaved", async () => {
  const before = { id: "user", role: "user" as const, content: "before" };
  const card = { id: "browser-input:one" };
  const after = { id: "assistant", role: "assistant" as const, content: "search result" };
  const scrollToIndex = jest.fn();
  const scrollItemIntoView = jest.fn(() => { throw new Error("not yet measured"); });
  const view = await renderHook(() => useChatScrollNavigation({ messages: [before, card, after],
    listRef: { current: { scrollToIndex, scrollItemIntoView } } as never,
    isAtBottomRef: { current: false }, interactionActiveRef: { current: false }, pauseAutoScroll() {}, resumeAutoScroll() {}, scrollToBottom() {} }));
  await act(() => view.result.current.scrollToMessage(after, 0.2));
  expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: true, viewPosition: 0.2 });
});

it("scrolls an externally linked message with the existing chat navigation", async () => {
  jest.spyOn(global, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const item = { id: "message-2", role: "assistant" as const, content: "target" };
  const scrollItemIntoView = jest.fn();
  const pauseAutoScroll = jest.fn();
  const onDeepLinkHandled = jest.fn();
  await renderHook(() => useChatScrollNavigation({
    messages: [{ id: "message-1", role: "user" }, item],
    listRef: { current: { scrollItemIntoView } } as never,
    isAtBottomRef: { current: true },
    interactionActiveRef: { current: false },
    pauseAutoScroll,
    resumeAutoScroll: jest.fn(),
    scrollToBottom: jest.fn(),
    deepLinkTarget: { requestId: 7, sessionId: "session-1", messageId: "message-2" },
    sessionId: "session-1",
    onDeepLinkHandled,
  }));
  expect(pauseAutoScroll).toHaveBeenCalled();
  expect(scrollItemIntoView).toHaveBeenCalledWith({ item, animated: true });
  expect(onDeepLinkHandled).toHaveBeenCalledWith(7);
  jest.restoreAllMocks();
});

it("keeps scroll interaction state inside chat navigation", async () => {
  const interactionActiveRef = { current: false };
  const pauseAutoScroll = jest.fn();
  const resumeAutoScroll = jest.fn();
  const { result } = await renderHook(() => useChatScrollNavigation({
    messages: [],
    listRef: { current: null },
    isAtBottomRef: { current: true },
    interactionActiveRef,
    pauseAutoScroll,
    resumeAutoScroll,
    scrollToBottom: jest.fn(),
  }));
  await act(() => result.current.handleScrollInteractionBegin());
  expect(interactionActiveRef.current).toBe(true);
  expect(pauseAutoScroll).toHaveBeenCalledTimes(1);
  await act(() => result.current.handleScrollInteractionEnd());
  expect(interactionActiveRef.current).toBe(false);
  expect(resumeAutoScroll).toHaveBeenCalledTimes(1);
});

it("does not pause or report a message scroll before the list ref is set", async () => {
  const pauseAutoScroll = jest.fn();
  const message = { id: "message-1", role: "assistant" as const, content: "target" };
  const { result } = await renderHook(() => useChatScrollNavigation({
    messages: [message],
    listRef: { current: null },
    isAtBottomRef: { current: true },
    interactionActiveRef: { current: false },
    pauseAutoScroll,
    resumeAutoScroll: jest.fn(),
    scrollToBottom: jest.fn(),
  }));

  expect(result.current.scrollToMessage(message)).toBe(false);
  expect(pauseAutoScroll).not.toHaveBeenCalled();
});
