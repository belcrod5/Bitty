import { act, renderHook } from "@testing-library/react-native";
import { useBufferedClientLogs, type BufferedLogEntrySeed } from "./useBufferedClientLogs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ok = { ok: true, json: async () => ({}) } as Response;

function renderLogs() {
  return renderHook(() => useBufferedClientLogs({
    enabled: true, source: "test", runnerUrl: "http://runner.test", runnerToken: "test-token",
    getBaseUrl: () => "http://runner.test", createSessionId: () => "test-session",
    createEntry: (entry: BufferedLogEntrySeed) => entry,
    bufferMax: 4, flushBatchSize: 2, flushDelayMs: 1000, retryMs: 2000,
  }));
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test("an in-flight acknowledgement removes only sent entries after overflow shifts the buffer", async () => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result } = await renderLogs();
  await act(() => { result.current.enqueue("one", {}); result.current.enqueue("two", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush(); });
  await act(() => { for (let i = 3; i <= 7; i++) result.current.enqueue(`event-${i}`, {}); });
  await act(async () => { response.resolve(ok); await pending; });
  expect(result.current.queuedCount).toBe(4);
  await act(async () => { await result.current.sendNow(); });
  const seqs = fetch.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events.map((entry: BufferedLogEntrySeed) => entry.seq));
  // seq3 was evicted by the existing cap; seq4/5 were never sent by the first request.
  expect(seqs).toEqual([1, 2, 4, 5, 6, 7]);
  expect(result.current.queuedCount).toBe(0);
});

test.each([true, false])("clearLocal during an in-flight request preserves subsequently enqueued logs (success=%s)", async (success) => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result } = await renderLogs();
  await act(() => { result.current.enqueue("old", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush(); });
  await act(() => { result.current.clearLocal(); result.current.enqueue("new", {}); });
  await act(async () => { if (success) response.resolve(ok); else response.reject(new Error("offline")); await pending; });
  expect(result.current.queuedCount).toBe(1);
  await act(async () => { await result.current.sendNow(); });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).events.map((entry: BufferedLogEntrySeed) => entry.event)).toEqual(["new"]);
});

test("a failed send retries retained entries without losing new logs", async () => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result } = await renderLogs();
  await act(() => { result.current.enqueue("old", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush(); });
  await act(() => { result.current.enqueue("new", {}); });
  await act(async () => { response.reject(new Error("offline")); await pending; });
  expect(result.current.queuedCount).toBe(2);
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).events.map((entry: BufferedLogEntrySeed) => entry.event)).toEqual(["old", "new"]);
  expect(result.current.queuedCount).toBe(0);
});
