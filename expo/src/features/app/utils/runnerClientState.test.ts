import { requestRunnerClientState, RunnerClientStateConnectionError, runnerSessionKey, runnerSessionValue, type RunnerClientState, type RunnerClientStateCache } from "./runnerClientState";

test("custom session metadata is isolated by backend", () => {
  const values = {
    [runnerSessionKey("codex", "same")]: "Codex title",
    [runnerSessionKey("claude", "same")]: "Claude title",
  };
  expect(runnerSessionValue(values, "codex", "same")).toBe("Codex title");
  expect(runnerSessionValue(values, "claude", "same")).toBe("Claude title");
  expect(runnerSessionValue(values, "codex", "other")).toBeUndefined();
});

test("unscoped old titles are not reused by another backend", () => {
  const values = { [runnerSessionKey("legacy", "same")]: "Old title" };
  expect(runnerSessionValue(values, "codex", "same")).toBeUndefined();
  expect(runnerSessionValue(values, "claude", "same")).toBeUndefined();
});

describe("conditional client-state requests", () => {
  const auth = { runnerUrl: "http://runner.test/", runnerToken: "token" };
  let cache: RunnerClientStateCache;
  let fetchMock: jest.SpyInstance;
  const snapshot = (revision = 1, message = "original"): RunnerClientState => ({
    revision, titleModelId: "gpt-6-luna", titleReasoningEffort: "low", directories: [],
    sessions: {}, composerHistory: [message], drafts: {},
  });
  const response = (value: RunnerClientState | undefined, etag?: string, status = 200) => ({
    status, ok: status === 200,
    headers: { get: (name: string) => name === "etag" ? etag || null : null },
    json: jest.fn(async () => ({ snapshot: value })),
  });
  beforeEach(() => {
    cache = {};
    fetchMock = jest.spyOn(global, "fetch");
  });
  afterEach(() => jest.restoreAllMocks());
  const headersAt = (index: number) => fetchMock.mock.calls[index][1].headers;

  test("every GET reaches the server and a matching 304 reuses its paired body", async () => {
    const value = snapshot();
    const unchanged = response(undefined, '"first"', 304);
    fetchMock.mockResolvedValueOnce(response(value, '"first"')).mockResolvedValueOnce(unchanged);
    expect(await requestRunnerClientState({ ...auth, cache })).toBe(value);
    expect(await requestRunnerClientState({ ...auth, cache })).toBe(value);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersAt(0)["if-none-match"]).toBeUndefined();
    expect(headersAt(1)["if-none-match"]).toBe('"first"');
    expect(fetchMock.mock.calls[1][1].cache).toBe("no-store");
    expect(unchanged.json).not.toHaveBeenCalled();
  });

  test("a changed response replaces the body even when a restored store has the same revision", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockResolvedValueOnce(response(snapshot(1, "restored"), '"restored"'));
    await requestRunnerClientState({ ...auth, cache });
    expect((await requestRunnerClientState({ ...auth, cache })).composerHistory).toEqual(["restored"]);
    expect(cache.entry?.etag).toBe('"restored"');
  });

  test("a mutation retains its full response and seeds the next GET validator", async () => {
    const changed = snapshot(2, "new draft");
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockResolvedValueOnce(response(changed, '"second"')).mockResolvedValueOnce(response(undefined, '"second"', 304));
    await requestRunnerClientState({ ...auth, cache });
    const operation = { type: "draft.set", backendId: "codex", sessionId: "one", text: "new draft" };
    expect(await requestRunnerClientState({ ...auth, cache, operation })).toBe(changed);
    expect(headersAt(1)["if-none-match"]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operation });
    expect(cache.entry?.etag).toBe('"second"');
    expect(await requestRunnerClientState({ ...auth, cache })).toBe(changed);
    expect(headersAt(2)["if-none-match"]).toBe('"second"');
  });

  test("a failed mutation invalidates the old GET validator", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(response(snapshot(2), '"second"'));
    await requestRunnerClientState({ ...auth, cache });
    await expect(requestRunnerClientState({ ...auth, cache, operation: { type: "composer.append", text: "new" } })).rejects.toThrow("write failed");
    expect(cache.entry).toBeUndefined();
    await requestRunnerClientState({ ...auth, cache });
    expect(headersAt(2)["if-none-match"]).toBeUndefined();
  });

  test("an older server without ETag returns full state and clears the old validator", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockResolvedValue(response(snapshot(2)));
    await requestRunnerClientState({ ...auth, cache });
    await requestRunnerClientState({ ...auth, cache });
    expect(cache.entry).toBeUndefined();
    await requestRunnerClientState({ ...auth, cache });
    expect(headersAt(2)["if-none-match"]).toBeUndefined();
  });

  test("URL and token changes never send another connection's validator", async () => {
    fetchMock.mockResolvedValue(response(snapshot(), '"first"'));
    await requestRunnerClientState({ ...auth, cache });
    await requestRunnerClientState({ ...auth, runnerUrl: "https://other-runner.test", cache });
    await requestRunnerClientState({ ...auth, cache });
    await requestRunnerClientState({ ...auth, runnerToken: "new-token", cache });
    for (let index = 0; index < 4; index++) expect(headersAt(index)["if-none-match"]).toBeUndefined();
    expect(headersAt(3).authorization).toBe("Bearer new-token");
  });

  test("a 304 without a paired body retries once without a validator", async () => {
    fetchMock.mockResolvedValueOnce(response(undefined, '"orphan"', 304))
      .mockResolvedValueOnce(response(snapshot(), '"fresh"'));
    expect((await requestRunnerClientState({ ...auth, cache })).revision).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersAt(1)["if-none-match"]).toBeUndefined();
    expect(cache.entry?.etag).toBe('"fresh"');
  });

  test("a mismatched 304 validator cannot return the cached body", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockResolvedValueOnce(response(undefined, '"different"', 304))
      .mockResolvedValueOnce(response(snapshot(2), '"second"'));
    await requestRunnerClientState({ ...auth, cache });
    expect((await requestRunnerClientState({ ...auth, cache })).revision).toBe(2);
    expect(headersAt(2)["if-none-match"]).toBeUndefined();
  });

  test.each([['W/"first"', '"first"'], ['"first"', 'W/"first"']])(
    "weak and strong forms of the same tag (%s → %s) reuse the validated body",
    async (cachedTag, validatedTag) => {
      const value = snapshot();
      fetchMock.mockResolvedValueOnce(response(value, cachedTag))
        .mockResolvedValueOnce(response(undefined, validatedTag, 304));
      await requestRunnerClientState({ ...auth, cache });
      expect(await requestRunnerClientState({ ...auth, cache })).toBe(value);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  test("failed validation rejects instead of silently returning stale state", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"'))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(snapshot(2, "from another device"), '"second"'));
    await requestRunnerClientState({ ...auth, cache });
    await expect(requestRunnerClientState({ ...auth, cache })).rejects.toThrow("offline");
    expect((await requestRunnerClientState({ ...auth, cache })).composerHistory).toEqual(["from another device"]);
    expect(headersAt(2)["if-none-match"]).toBe('"first"');
  });

  test("authentication errors do not return or replace the last validated body", async () => {
    fetchMock.mockResolvedValueOnce(response(snapshot(), '"first"')).mockResolvedValueOnce(response(undefined, undefined, 401));
    await requestRunnerClientState({ ...auth, cache });
    await expect(requestRunnerClientState({ ...auth, cache })).rejects.toThrow("Runner HTTP 401");
    expect(cache.entry?.etag).toBe('"first"');
  });
});

describe("client-state transport failures", () => {
  const auth = { runnerUrl: "http://runner.test", runnerToken: "token" };
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  test("a timed-out fetch is a connection error and the existing 12-second timeout is unchanged", async () => {
    jest.useFakeTimers();
    jest.spyOn(global, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    const request = requestRunnerClientState(auth);
    const rejection = expect(request).rejects.toBeInstanceOf(RunnerClientStateConnectionError);
    jest.advanceTimersByTime(12_000);
    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a timeout while reading the response is also a connection error", async () => {
    jest.useFakeTimers();
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")))),
    } as Response));
    const request = requestRunnerClientState(auth);
    const rejection = expect(request).rejects.toBeInstanceOf(RunnerClientStateConnectionError);
    await Promise.resolve();
    jest.advanceTimersByTime(12_000);
    await rejection;
  });

  test.each([401, 409, 500])("HTTP %s remains a save error", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status, json: async () => ({ message: "Save rejected" }) } as Response);
    await expect(requestRunnerClientState(auth)).rejects.not.toBeInstanceOf(RunnerClientStateConnectionError);
  });
});

test("interrupted response bodies are connection failures but malformed JSON stays a save error", async () => {
  const auth = { runnerUrl: "http://runner.test", runnerToken: "token" };
  const fetchMock = jest.spyOn(global, "fetch");
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new TypeError("Network request failed"); } } as unknown as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("Invalid JSON"); } } as unknown as Response);
  await expect(requestRunnerClientState(auth)).rejects.toBeInstanceOf(RunnerClientStateConnectionError);
  await expect(requestRunnerClientState(auth)).rejects.not.toBeInstanceOf(RunnerClientStateConnectionError);
  fetchMock.mockRestore();
});
