import { fetchRunnerSessionSummaries } from "./runnerSessionSummaries";

const auth = { baseUrl: "http://runner.test/", token: "test-token" };

afterEach(() => jest.restoreAllMocks());

test.each([0, 100, 101, 122])("fetches %i summary IDs in batches of at most 100", async (count) => {
  const ids = Array.from({ length: count }, (_, index) => `session-${index}`);
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessions: body.sessionIds.map((sessionId: string) => ({
        sessionId,
        directory: "/workspace",
        cwd: "/workspace",
        updatedAt: "2026-10-01T00:00:00.000Z",
        lastReadAt: "2026-10-01T01:00:00.000Z",
        source: "cli",
        firstUserMessage: "title",
        parentSessionId: "parent",
        contextUsage: { usedPct: 47 },
        modelRef: "gpt-6",
        reasoningEffort: "high",
        latestToolLabel: "read_file",
        lastToolLabel: "write_file",
      })) }),
    } as Response;
  });
  const summaries = await fetchRunnerSessionSummaries(auth, { directory: "/workspace", sessionIds: ids }, 12_000);
  expect(summaries.map((item) => item.sessionId)).toEqual(ids);
  expect(fetchMock).toHaveBeenCalledTimes(Math.ceil(count / 100));
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).sessionIds.length))
    .toEqual(count === 0 ? [] : count <= 100 ? [count] : [100, count - 100]);
  if (count > 0) expect(summaries[0]).toMatchObject({
    directory: "/workspace", cwd: "/workspace", updatedAt: "2026-10-01T00:00:00.000Z",
    lastReadAt: "2026-10-01T01:00:00.000Z", source: "cli", firstUserMessage: "title",
    parentSessionId: "parent", contextUsage: { usedPct: 47 }, modelRef: "gpt-6",
    reasoningEffort: "high", latestToolLabel: "read_file", lastToolLabel: "write_file",
  });
});

test("deduplicates IDs before batching and rejects the whole result when batch two fails", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `session-${index}`);
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return {
      ok: fetchMock.mock.calls.length === 1,
      status: fetchMock.mock.calls.length === 1 ? 200 : 400,
      text: async () => JSON.stringify(fetchMock.mock.calls.length === 1
        ? { sessions: body.sessionIds.map((sessionId: string) => ({ sessionId })) }
        : { error: "too_many_session_ids" }),
    } as Response;
  });
  await expect(fetchRunnerSessionSummaries(auth, {
    directory: "/workspace", sessionIds: [...ids, ids[0], "", ids[100]],
  }, 12_000)).rejects.toThrow("too_many_session_ids");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).sessionIds.length)).toEqual([100, 1]);
});

test("returns each requested summary once when IDs repeat", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const { sessionIds } = JSON.parse(String(init?.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({
      sessions: sessionIds.map((sessionId: string) => ({ sessionId })),
    }) } as Response;
  });
  const summaries = await fetchRunnerSessionSummaries(auth, {
    directory: "/workspace", sessionIds: ["one", "two", "one", "two"],
  }, 12_000);
  expect(summaries.map((item) => item.sessionId)).toEqual(["one", "two"]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("handles a malformed success body without discarding valid future responses", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true, status: 200, text: async () => "null",
  } as Response);
  await expect(fetchRunnerSessionSummaries(auth, {
    directory: "/workspace", sessionIds: ["one"],
  }, 12_000)).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("normalizes auth and keeps the requested timeout signal", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true, status: 200, text: async () => JSON.stringify({ sessions: [] }),
  } as Response);
  await fetchRunnerSessionSummaries(
    { baseUrl: " http://runner.test/ ", token: " token " },
    { directory: "/workspace", sessionIds: ["one"] },
    15_000,
  );
  expect(fetchMock).toHaveBeenCalledWith("http://runner.test/session-summaries", expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer token" }),
    signal: expect.any(AbortSignal),
  }));
  await expect(fetchRunnerSessionSummaries(
    { baseUrl: " ", token: "token" },
    { directory: "/workspace", sessionIds: ["one"] }, 15_000,
  )).rejects.toThrow("Runner URL");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("aborts a timed-out summary batch and clears its timer", async () => {
  jest.useFakeTimers();
  try {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(() => new Promise(() => {}));
    const request = fetchRunnerSessionSummaries(auth, {
      directory: "/workspace", sessionIds: ["one"],
    }, 12_000);
    const failed = expect(request).rejects.toThrow("request timeout (12000ms)");
    await jest.advanceTimersByTimeAsync(12_000);
    await failed;
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
