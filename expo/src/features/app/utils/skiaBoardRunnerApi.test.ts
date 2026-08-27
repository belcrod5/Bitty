import {
  fetchSkiaBoard,
  importSkiaBoard,
  postSkiaBoardOps,
} from "./skiaBoardRunnerApi";

jest.mock("./persistedSettingsFile", () => ({
  SKIA_BOARD_STATE_FIELD: "skiaBoardState",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const auth = { runnerUrl: "http://runner/", runnerToken: "token" };
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function respond(status: number, payload: unknown) {
  mockFetch.mockResolvedValueOnce({
    status,
    json: async () => payload,
  });
}

test("fetchSkiaBoard normalizes the snapshot and strips the trailing slash", async () => {
  respond(200, {
    initialized: true,
    revision: 3,
    board: {
      cards: [{ sessionId: "session-1", col: 0, row: 1, directory: "/w", backendId: "codex" }],
      sections: [],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 10,
    },
  });

  const snapshot = await fetchSkiaBoard(auth);

  expect(mockFetch.mock.calls[0][0]).toBe("http://runner/skia-board");
  expect(mockFetch.mock.calls[0][1].headers.authorization).toBe("Bearer token");
  expect(snapshot.initialized).toBe(true);
  expect(snapshot.revision).toBe(3);
  expect(snapshot.board?.cards).toEqual([{
    kind: "session",
    sessionId: "session-1",
    directory: "/w",
    backendId: "codex",
    col: 0,
    row: 1,
  }]);
});

test("fetchSkiaBoard maps an initialized empty board to an empty state", async () => {
  respond(200, {
    initialized: true,
    revision: 5,
    board: { cards: [], sections: [], excludedSessionIds: [], ingestedUpdatedAtMs: 0 },
  });
  const snapshot = await fetchSkiaBoard(auth);
  expect(snapshot.board?.cards).toEqual([]);
});

test("fetchSkiaBoard rejects when auth is missing or the runner errors", async () => {
  await expect(fetchSkiaBoard({ runnerUrl: "", runnerToken: "" })).rejects.toThrow(/未設定/);
  respond(503, { error: "skia_board_store_unavailable", message: "store broken" });
  await expect(fetchSkiaBoard(auth)).rejects.toThrow("store broken");
});

test("postSkiaBoardOps returns conflict and not_initialized results instead of throwing", async () => {
  respond(409, { error: "revision_conflict", initialized: true, revision: 7, board: { cards: [] } });
  const conflict = await postSkiaBoardOps(auth, { baseRevision: 1, ops: [{ type: "tidyCards" }] });
  expect(conflict.status).toBe("conflict");
  expect(conflict.snapshot.revision).toBe(7);

  respond(409, { error: "not_initialized", initialized: false, revision: 0, board: null });
  const uninitialized = await postSkiaBoardOps(auth, { baseRevision: 0, ops: [{ type: "tidyCards" }] });
  expect(uninitialized.status).toBe("not_initialized");
  expect(uninitialized.snapshot.board).toBeNull();

  respond(400, { error: "invalid_skia_board_request", message: "bad ops" });
  await expect(postSkiaBoardOps(auth, { baseRevision: 0, ops: [] })).rejects.toThrow("bad ops");
});

test("importSkiaBoard returns already_initialized with the current snapshot", async () => {
  respond(409, {
    error: "already_initialized",
    initialized: true,
    revision: 4,
    board: { cards: [{ sessionId: "kept", col: 0, row: 0 }] },
  });
  const result = await importSkiaBoard(auth, { board: { cards: [] } });
  expect(result.status).toBe("already_initialized");
  expect(result.snapshot.revision).toBe(4);
  expect(result.snapshot.board?.cards[0]).toMatchObject({ sessionId: "kept" });
});
