import { act, renderHook } from "@testing-library/react-native";
import type { RunnerSessionMessagesResult } from "./useLlmSessionExplorer";
import { useSessionHistoryPagingController } from "./useSessionHistoryPagingController";

function page(cursor: string | null): RunnerSessionMessagesResult {
  return {
    threadId: "thread-1",
    sourceKind: "appServer",
    cwd: "/workspace",
    updatedAt: "",
    modelRef: "",
    reasoningEffort: "",
    latestToolLabel: "",
    messages: [],
    contextUsedPct: null,
    hasRunningTurn: false,
    runningTurn: null,
    olderCursor: cursor,
  };
}

it("loads one opaque cursor at a time and applies the next cursor", async () => {
  const fetchPage = jest.fn().mockResolvedValue(page("cursor-2"));
  const applyPage = jest.fn();
  const { result } = await renderHook(() => useSessionHistoryPagingController({ fetchPage, applyPage }));

  await act(() => result.current.registerPage("thread-1", page("cursor-1")));
  await act(async () => {
    await Promise.all([
      result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" }),
      result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" }),
    ]);
  });

  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(fetchPage).toHaveBeenCalledWith("thread-1", "/workspace", { cursor: "cursor-1" });
  expect(applyPage).toHaveBeenCalledTimes(1);
  expect(result.current.stateBySessionId["thread-1"]).toEqual({
    olderCursor: "cursor-2",
    loading: false,
    error: "",
    errorCode: "",
  });
});

it("discards a response after a newer initial page is registered", async () => {
  let resolvePage: ((value: RunnerSessionMessagesResult) => void) | null = null;
  const fetchPage = jest.fn(() => new Promise<RunnerSessionMessagesResult>((resolve) => {
    resolvePage = resolve;
  }));
  const applyPage = jest.fn();
  const { result } = await renderHook(() => useSessionHistoryPagingController({ fetchPage, applyPage }));

  await act(() => result.current.registerPage("thread-1", page("old-cursor")));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" });
    await Promise.resolve();
  });
  await act(() => result.current.registerPage("thread-1", page("new-cursor")));
  await act(async () => {
    resolvePage?.(page(null));
    await pending!;
  });

  expect(applyPage).not.toHaveBeenCalled();
  expect(result.current.stateBySessionId["thread-1"]?.olderCursor).toBe("new-cursor");
});

it("waits for an explicit retry after a page error", async () => {
  const fetchPage = jest.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(page(null));
  const applyPage = jest.fn();
  const { result } = await renderHook(() => useSessionHistoryPagingController({ fetchPage, applyPage }));
  await act(() => result.current.registerPage("thread-1", page("cursor-1")));

  await act(() => result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" }));
  await act(() => result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" }));
  expect(fetchPage).toHaveBeenCalledTimes(1);

  await act(() => result.current.loadOlder({
    sessionId: "thread-1",
    directory: "/workspace",
    retry: true,
  }));
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(applyPage).toHaveBeenCalledTimes(1);
});

it("keeps a stale cursor error code so the UI does not offer a futile retry", async () => {
  const stale = Object.assign(new Error("セッションを開き直してください"), {
    code: "stale_history_cursor",
  });
  const fetchPage = jest.fn().mockRejectedValue(stale);
  const { result } = await renderHook(() => useSessionHistoryPagingController({
    fetchPage,
    applyPage: jest.fn(),
  }));
  await act(() => result.current.registerPage("thread-1", page("cursor-1")));

  await act(() => result.current.loadOlder({ sessionId: "thread-1", directory: "/workspace" }));

  expect(result.current.stateBySessionId["thread-1"]?.errorCode).toBe("stale_history_cursor");
});
