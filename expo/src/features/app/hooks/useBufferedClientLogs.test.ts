import { act, renderHook } from "@testing-library/react-native";
import { useBufferedClientLogs, type BufferedLogEntrySeed } from "./useBufferedClientLogs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ok = { ok: true, json: async () => ({}) } as Response;

function renderLogs({ bufferMax = 4, flushBatchSize = 2, flushDelayMs = 1000 } = {}) {
  return renderHook((config: { enabled: boolean; runnerUrl: string; runnerToken: string }) => useBufferedClientLogs({
    ...config, source: "test",
    getBaseUrl: () => config.runnerUrl, createSessionId: () => "test-session",
    createEntry: (entry: BufferedLogEntrySeed) => entry,
    bufferMax, flushBatchSize, flushDelayMs, retryMs: 2000,
  }), { initialProps: { enabled: true, runnerUrl: "http://runner.test", runnerToken: "test-token" } });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test("an in-flight acknowledgement removes only sent entries after overflow shifts the buffer", async () => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result } = await renderLogs();
  await act(() => { result.current.enqueue("one", {}); result.current.enqueue("two", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush({ maxBatches: 1 }); });
  await act(() => { for (let i = 3; i <= 7; i++) result.current.enqueue(`event-${i}`, {}); });
  await act(async () => { response.resolve(ok); await pending; });
  await act(async () => { await result.current.flush({ maxBatches: 12 }); });
  const seqs = fetch.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events.map((entry: BufferedLogEntrySeed) => entry.seq));
  // seq3 was evicted by the existing cap; seq4/5 were never sent by the first request.
  expect(seqs).toEqual([1, 2, 4, 5, 6, 7]);
});

test("a failed send retries retained entries without losing new logs", async () => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result } = await renderLogs();
  await act(() => { result.current.enqueue("old", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush({ maxBatches: 1 }); });
  await act(() => { result.current.enqueue("new", {}); });
  await act(async () => { response.reject(new Error("offline")); await pending; });
  await act(async () => { await jest.advanceTimersByTimeAsync(1999); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).events.map((entry: BufferedLogEntrySeed) => entry.event)).toEqual(["old", "new"]);
});


test.each([225, 230])("reproduces a %i-event sequence gap when a delayed send overlaps a burst beyond the unchanged cap", async (gap) => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue(ok);
  fetch.mockResolvedValueOnce(ok).mockResolvedValueOnce(ok).mockReturnValueOnce(response.promise);
  const { result } = await renderLogs({ bufferMax: 240, flushBatchSize: 40, flushDelayMs: 700 });
  await act(() => { for (let seq = 1; seq <= 100; seq++) result.current.enqueue("prefix", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush({ maxBatches: 3 }); });
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(() => { for (let seq = 101; seq <= 340 + gap; seq++) result.current.enqueue(seq === 125 ? "session_history_batch_done" : "burst", {}); });
  await act(async () => { response.resolve(ok); await pending; await result.current.flush({ maxBatches: 12 }); });
  const events = fetch.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events as BufferedLogEntrySeed[]);
  expect(events.map((entry) => entry.seq)).toEqual([
    ...Array.from({ length: 100 }, (_, i) => i + 1), ...Array.from({ length: 240 }, (_, i) => i + 101 + gap),
  ]);
  expect(events.some((entry) => entry.event === "session_history_batch_done")).toBe(false);
  const metadata = events.filter((entry) => typeof entry.payload.clientLogBufferEvictedCount === "number");
  expect(metadata[metadata.length - 1].payload).toMatchObject({
    clientLogGeneratedThroughSeq: 340 + gap, clientLogBufferEvictedCount: gap + 20,
  });
  expect(metadata.every((entry, index) => index === 0
    || Number(entry.payload.clientLogBufferEvictedCount) >= Number(metadata[index - 1].payload.clientLogBufferEvictedCount))).toBe(true);
});

test("drains a representative paced burst without inserting the coalescing delay between queued batches", async () => {
  const fetch = jest.spyOn(global, "fetch").mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return ok;
  });
  const { result } = await renderLogs({ bufferMax: 240, flushBatchSize: 40, flushDelayMs: 700 });
  for (let wave = 0; wave < 12; wave++) {
    await act(() => { for (let n = 0; n < 40; n++) result.current.enqueue(wave === 4 && n === 0 ? "session_history_batch_done" : "burst", {}); });
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
  }
  await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
  const events = fetch.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events as BufferedLogEntrySeed[]);
  console.info("buffered_log_paced_burst", JSON.stringify({ produced: 480, observed: events.length, completionObserved: events.some((entry) => entry.event === "session_history_batch_done") }));
  expect(events.map((entry) => entry.seq)).toEqual(Array.from({ length: 480 }, (_, i) => i + 1));
  expect(events.filter((entry) => entry.event === "session_history_batch_done")).toHaveLength(1);
});


test("log enqueue and successful flush do not rerender the owning component", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(ok);
  let renders = 0;
  const { result } = await renderHook(() => {
    renders++;
    return useBufferedClientLogs({ enabled: true, source: "test", runnerUrl: "http://runner.test", runnerToken: "test-token",
      getBaseUrl: () => "http://runner.test", createSessionId: () => "test-session", createEntry: (entry: BufferedLogEntrySeed) => entry,
      bufferMax: 240, flushBatchSize: 40, flushDelayMs: 700, retryMs: 2000 });
  });
  await act(() => { for (let i = 0; i < 80; i++) result.current.enqueue("event", {}); });
  await act(async () => { await result.current.flush(); });
  console.info("buffered_log_owner_renders", JSON.stringify({ renders }));
  expect(renders).toBe(1);
});

test("piggybacks cumulative eviction/sequence observations without mutating entries", async () => {
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue(ok);
  const { result } = await renderLogs();
  const originals: BufferedLogEntrySeed[] = [];
  const payload = Object.freeze({ fixture: true });
  await act(() => { for (let i = 0; i < 7; i++) {
    const entry = result.current.enqueue("event", payload)!;
    originals.push(entry);
    Object.freeze(entry.payload);
    Object.freeze(entry);
  } });
  await act(async () => { await result.current.flush({ maxBatches: 1 }); });
  const first = JSON.parse(String(fetch.mock.calls[0][1]?.body)).events[0];
  expect(first.payload).toEqual({ fixture: true, clientLogGeneratedThroughSeq: 7, clientLogBufferEvictedCount: 3 });
  expect(originals[3].seq).toBe(first.seq);
  expect(originals[3].payload).toEqual({ fixture: true });
  expect(payload).toEqual({ fixture: true });
  await act(() => { result.current.enqueue("new", {}); });
  await act(async () => { await result.current.flush(); });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).events[0].payload).toMatchObject({
    clientLogGeneratedThroughSeq: 8, clientLogBufferEvictedCount: 3,
  });
});

test.each([true, false])("unmount during an in-flight send starts no later requests or retry timers (success=%s)", async (success) => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValue(response.promise);
  const { result, unmount } = await renderLogs();
  await act(() => { for (let i = 0; i < 4; i++) result.current.enqueue("event", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush(); });
  await unmount();
  const timers = jest.spyOn(global, "setTimeout");
  await act(async () => { if (success) response.resolve(ok); else response.reject(new Error("offline")); await pending; });
  expect(timers.mock.calls.filter(([, delay]) => delay === 1000 || delay === 2000)).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});


test("bounded automatic draining yields after twelve batches and sends the remainder later", async () => {
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue(ok);
  const { result } = await renderLogs({ bufferMax: 40 });
  await act(() => { for (let i = 0; i < 30; i++) result.current.enqueue("event", {}); });
  await act(async () => { await result.current.flush(); });
  expect(fetch).toHaveBeenCalledTimes(12);
  await act(async () => { await jest.advanceTimersByTimeAsync(999); });
  expect(fetch).toHaveBeenCalledTimes(12);
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(15);
  expect(fetch.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).events).map((entry: BufferedLogEntrySeed) => entry.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
});

test.each(["disabled", "url", "token"])("an in-flight drain stops on %s changes and retained entries resume with current options", async (change) => {
  const response = deferred<Response>();
  const fetch = jest.spyOn(global, "fetch").mockReturnValueOnce(response.promise).mockResolvedValue(ok);
  const { result, rerender } = await renderLogs();
  await act(() => { for (let i = 0; i < 4; i++) result.current.enqueue("event", {}); });
  let pending!: Promise<void>;
  await act(() => { pending = result.current.flush(); });
  const next = { enabled: change !== "disabled", runnerUrl: change === "url" ? "http://runner-next.test" : "http://runner.test",
    runnerToken: change === "token" ? "next-token" : "test-token" };
  await rerender(next);
  await act(async () => { await jest.advanceTimersByTimeAsync(300); });
  await act(async () => { response.resolve(ok); await pending; });
  expect(fetch).toHaveBeenCalledTimes(1);
  if (change === "disabled") {
    await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await rerender({ ...next, enabled: true });
  }
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe(`${next.runnerUrl}/client-logs`);
  expect((fetch.mock.calls[1][1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${next.runnerToken}`);
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).events.map((entry: BufferedLogEntrySeed) => entry.seq)).toEqual([3, 4]);
});
