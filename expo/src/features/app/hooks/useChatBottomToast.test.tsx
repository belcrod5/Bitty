import { act, renderHook } from "@testing-library/react-native";
import { useChatBottomToast } from "./useChatBottomToast";

const options = { visibleMs: 2600, trimText: (text: string) => text };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("toast disappears automatically and repeated notifications restart its lifetime", async () => {
  const { result } = await renderHook(() => useChatBottomToast(options));
  await act(async () => { result.current.showChatBottomToast("assistant", "コピーしました"); });
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(result.current.chatBottomToast?.text).toBe("コピーしました");
  await act(async () => { result.current.showChatBottomToast("assistant", "コピーしました"); });
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(result.current.chatBottomToast?.text).toBe("コピーしました");
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(result.current.chatBottomToast).toBeNull();
});

test("hiding and unmounting clear the pending notification timers", async () => {
  const timeout = jest.spyOn(global, "setTimeout");
  const clear = jest.spyOn(global, "clearTimeout");
  try {
    const { result, unmount } = await renderHook(() => useChatBottomToast(options));
    await act(async () => { result.current.showChatBottomToast("assistant", "保存しました"); });
    const first = timeout.mock.results[timeout.mock.calls.findIndex(([, delay]) => delay === 2600)].value;
    await act(async () => { result.current.hideChatBottomToast(); });
    expect(result.current.chatBottomToast).toBeNull();
    expect(clear).toHaveBeenCalledWith(first);
    await act(async () => { result.current.showChatBottomToast("assistant", "コピーしました"); });
    const lastIndex = timeout.mock.calls.map(([, delay]) => delay).lastIndexOf(2600);
    const last = timeout.mock.results[lastIndex].value;
    await unmount();
    expect(clear).toHaveBeenCalledWith(last);
  } finally { timeout.mockRestore(); clear.mockRestore(); }
});
