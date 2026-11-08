import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useComputerBrowser } from "./useComputerBrowser";

const originalFetch = global.fetch;
const computer = { hostname: "Mac", homePath: "/home/me" };
const listing = (basePath: string) => ({ basePath, parentPath: "/home", entries: [], truncated: false });
const response = (value: unknown) => ({ ok: true, json: async () => value });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test("the latest directory request wins even when cancellation is ignored", async () => {
  let finishOld: (value: unknown) => void = () => {};
  const fetchMock = jest.fn().mockResolvedValueOnce(response(computer)).mockResolvedValueOnce(response(listing("/home/me")));
  global.fetch = fetchMock;
  const { result } = await renderHook(() => useComputerBrowser("http://runner", "token"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(response(listing("/new")));
  let oldRequest: Promise<void>;
  await act(async () => { oldRequest = result.current.browse("/old"); });
  await act(async () => { await result.current.browse("/new"); });
  await act(async () => { finishOld(response(listing("/old"))); await oldRequest!; });
  expect(result.current.directory?.basePath).toBe("/new");
  expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
});

test("missing connection credentials do not send requests", async () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;
  const { result } = await renderHook(() => useComputerBrowser("", ""));
  await waitFor(() => expect(result.current.error).toContain("接続を確認"));
  expect(result.current.loading).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("request timeout becomes a retryable error and unmount cancels requests", async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
    signal = init?.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  const { result, unmount } = await renderHook(() => useComputerBrowser("http://runner", "token"));
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current.error).toContain("タイムアウト");
  expect(result.current.loading).toBe(false);
  await unmount();
  expect(signal?.aborted).toBe(true);
});
