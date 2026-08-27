import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkiaBoardHttpHandler } from "../src/skia-board-http.mjs";
import { createSkiaBoardService } from "../src/skia-board-service.mjs";

const RUNNER_TOKEN = "test-runner-token";

async function withHandler(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skia-board-endpoint-"));
  try {
    const service = createSkiaBoardService({
      storePath: path.join(dir, "skia_board_state.json"),
    });
    const responses = [];
    const handler = createSkiaBoardHttpHandler({
      service,
      runnerToken: RUNNER_TOKEN,
      parseAuthToken: (req) => req.auth || "",
      readJsonBody: async (req) => req.body ?? {},
      json: (_res, status, payload) => responses.push({ status, payload }),
    });
    const call = async (method, pathname, body, auth = RUNNER_TOKEN) => {
      const handled = await handler({ method, auth, body }, {}, pathname);
      return { handled, response: responses.pop() };
    };
    await fn(call);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function importableBoard() {
  return {
    cards: [{ kind: "session", sessionId: "session-1", col: 0, row: 0 }],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
  };
}

test("ignores unrelated paths and rejects bad auth and methods", async () => {
  await withHandler(async (call) => {
    const unrelated = await call("GET", "/skia-board-other");
    assert.equal(unrelated.handled, false);
    assert.equal(unrelated.response, undefined);

    const unauthorized = await call("GET", "/skia-board", undefined, "wrong");
    assert.deepEqual(unauthorized.response, { status: 401, payload: { error: "unauthorized" } });

    const wrongMethod = await call("POST", "/skia-board", {});
    assert.deepEqual(wrongMethod.response, { status: 405, payload: { error: "method_not_allowed" } });
  });
});

test("GET /skia-board returns the current snapshot", async () => {
  await withHandler(async (call) => {
    const empty = await call("GET", "/skia-board");
    assert.deepEqual(empty.response, {
      status: 200,
      payload: { initialized: false, revision: 0, origin: null, board: null },
    });
  });
});

test("import then ops then conflict over HTTP", async () => {
  await withHandler(async (call) => {
    const imported = await call("POST", "/skia-board/import", { board: importableBoard() });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.response.payload.revision, 1);

    const reimported = await call("POST", "/skia-board/import", { board: importableBoard() });
    assert.equal(reimported.response.status, 409);
    assert.equal(reimported.response.payload.error, "already_initialized");
    assert.ok(reimported.response.payload.board);

    const ops = await call("POST", "/skia-board/ops", {
      baseRevision: 1,
      ops: [{ type: "addCard", card: { kind: "directory", directory: "/repo" } }],
    });
    assert.equal(ops.response.status, 200);
    assert.equal(ops.response.payload.revision, 2);
    assert.equal(ops.response.payload.board.cards.length, 2);

    const conflict = await call("POST", "/skia-board/ops", {
      baseRevision: 1,
      ops: [{ type: "tidyCards" }],
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.response.payload.error, "revision_conflict");
    assert.equal(conflict.response.payload.revision, 2);
    assert.ok(conflict.response.payload.board);
  });
});

test("ops on an uninitialized board return not_initialized", async () => {
  await withHandler(async (call) => {
    const ops = await call("POST", "/skia-board/ops", {
      baseRevision: 0,
      ops: [{ type: "tidyCards" }],
    });
    assert.equal(ops.response.status, 409);
    assert.equal(ops.response.payload.error, "not_initialized");
    assert.equal(ops.response.payload.initialized, false);
  });
});

test("validation errors map to 400", async () => {
  await withHandler(async (call) => {
    const invalid = await call("POST", "/skia-board/ops", { baseRevision: -1, ops: [{ type: "tidyCards" }] });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.payload.error, "invalid_skia_board_request");

    const emptyImport = await call("POST", "/skia-board/import", { board: { cards: [] } });
    assert.equal(emptyImport.response.status, 400);
  });
});

test("POST /skia-board/ingest-directories merges directories", async () => {
  await withHandler(async (call) => {
    const first = await call("POST", "/skia-board/ingest-directories", { directories: ["/a"] });
    assert.deepEqual(first.response, { status: 200, payload: { ingestDirectories: ["/a"] } });
    const second = await call("POST", "/skia-board/ingest-directories", { directories: ["/b", "/a"] });
    assert.deepEqual(second.response.payload.ingestDirectories, ["/a", "/b"]);
  });
});
