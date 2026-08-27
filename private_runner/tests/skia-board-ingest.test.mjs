import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkiaBoardIngest } from "../src/skia-board-ingest.mjs";
import { createSkiaBoardService } from "../src/skia-board-service.mjs";

function sessionsGroup(directory, sessions) {
  return {
    directory,
    sessionsById: new Map(sessions.map((session) => [
      JSON.stringify([session.backendId, session.sessionId]),
      { directory, ...session },
    ])),
  };
}

function candidate(index, backendId = "codex") {
  return {
    sessionId: `session-${index}`,
    backendId,
    updatedAt: `2026-06-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    lastReadAt: "",
  };
}

async function withHarness(fn, { sessionsByDirectory = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skia-board-ingest-"));
  try {
    const events = [];
    const listCalls = [];
    let nowMs = 1_000_000;
    const service = createSkiaBoardService({
      storePath: path.join(dir, "skia_board_state.json"),
      broadcast: (payload) => events.push(payload),
    });
    const ingest = createSkiaBoardIngest({
      boardService: service,
      listAgentSessionsForDirectories: async (directories) => {
        listCalls.push([...directories]);
        return directories.map((directory) => (
          sessionsGroup(directory, sessionsByDirectory[directory] || [])
        ));
      },
      resolveDirectory: (value) => value,
      now: () => new Date(nowMs),
      minSweepIntervalMs: 30_000,
    });
    await fn({
      service,
      ingest,
      events,
      listCalls,
      advance: (ms) => { nowMs += ms; },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sweep initializes an empty store with the latest six sessions as origin ingest", async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => candidate(index + 1));
  await withHarness(async ({ service, ingest, events }) => {
    await service.syncIngestDirectories({ directories: ["/work"] });
    const snapshot = await ingest.sweep();

    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.origin, "ingest");
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.board.cards.length, 6);
    // 最新6件が新しい順にグリッドへ載る。
    assert.deepEqual(
      snapshot.board.cards.map((card) => card.sessionId),
      ["session-8", "session-7", "session-6", "session-5", "session-4", "session-3"]
    );
    assert.deepEqual(snapshot.board.cards[0], {
      kind: "session",
      sessionId: "session-8",
      directory: "/work",
      backendId: "codex",
      col: 0,
      row: 0,
    });
    assert.equal(
      snapshot.board.ingestedUpdatedAtMs,
      new Date("2026-06-08T00:00:00.000Z").getTime()
    );
    assert.deepEqual(events, [{ revision: 1 }]);

    // 未編集のingest初期化はアプリからの引き継ぎ(import)で上書きできる。
    const imported = await service.importBoard({
      board: {
        cards: [{ kind: "session", sessionId: "user-session", col: 0, row: 0 }],
        sections: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 0,
      },
    });
    assert.equal(imported.origin, "import");
    assert.equal(imported.board.cards[0].sessionId, "user-session");
  }, { sessionsByDirectory: { "/work": sessions } });
});

test("sweep only stacks sessions newer than the watermark and respects exclusions", async () => {
  const sessionsByDirectory = {
    "/work": [candidate(1), candidate(5), candidate(9), { ...candidate(7), sessionId: "excluded" }],
  };
  await withHarness(async ({ service, ingest, advance }) => {
    await service.syncIngestDirectories({ directories: ["/work"] });
    await service.importBoard({
      board: {
        cards: [{ kind: "session", sessionId: "session-1", col: 0, row: 0 }],
        sections: [],
        excludedSessionIds: ["excluded"],
        ingestedUpdatedAtMs: new Date("2026-06-05T00:00:00.000Z").getTime(),
      },
    });

    const snapshot = await ingest.sweep({ force: true });
    // session-9 だけが空きセルへ積まれる(session-5は境界で対象外、excludedは除外)。
    assert.deepEqual(
      snapshot.board.cards.map((card) => card.sessionId),
      ["session-1", "session-9"]
    );
    assert.deepEqual(snapshot.board.cards[1], {
      kind: "session",
      sessionId: "session-9",
      directory: "/work",
      backendId: "codex",
      col: 1,
      row: 0,
    });

    // 変化が無い再スイープはrevisionを動かさない。
    advance(60_000);
    const unchanged = await ingest.sweep();
    assert.equal(unchanged.revision, snapshot.revision);
  }, { sessionsByDirectory });
});

test("sweep is throttled and skips listing when no directories are registered", async () => {
  await withHarness(async ({ service, ingest, listCalls, advance }) => {
    // 対象ディレクトリ未登録: 一覧取得は行わない。
    assert.equal(await ingest.sweep(), null);
    assert.deepEqual(listCalls, []);

    await service.syncIngestDirectories({ directories: ["/work"] });
    // スロットル間隔内の再実行はno-op。
    assert.equal(await ingest.sweep(), null);
    advance(30_001);
    await ingest.sweep();
    assert.deepEqual(listCalls, [["/work"]]);
  });
});

test("onTurnCompleted ingests only registered directories", async () => {
  const sessionsByDirectory = { "/work": [candidate(2)] };
  await withHarness(async ({ service, ingest, listCalls }) => {
    await service.syncIngestDirectories({ directories: ["/work"] });

    assert.equal(await ingest.onTurnCompleted({ directory: "/elsewhere" }), null);
    assert.equal(await ingest.onTurnCompleted({ directory: "" }), null);
    assert.deepEqual(listCalls, []);

    const snapshot = await ingest.onTurnCompleted({
      backendId: "codex",
      sessionId: "session-2",
      directory: "/work",
      completedAt: "2026-06-02T00:00:01.000Z",
    });
    assert.deepEqual(listCalls, [["/work"]]);
    assert.equal(snapshot.origin, "ingest");
    assert.deepEqual(snapshot.board.cards.map((card) => card.sessionId), ["session-2"]);
  }, { sessionsByDirectory });
});

test("onTurnCompleted ingests across all registered directories", async () => {
  // 単一ディレクトリの候補だけでウォーターマークが前進すると他ディレクトリの
  // セッションが恒久的に取りこぼされるため、常に全登録ディレクトリを対象にする。
  const sessionsByDirectory = {
    "/work-a": [candidate(9)],
    "/work-b": [{ ...candidate(2), sessionId: "b-session" }],
  };
  await withHarness(async ({ service, ingest, listCalls }) => {
    await service.syncIngestDirectories({ directories: ["/work-a", "/work-b"] });

    const snapshot = await ingest.onTurnCompleted({ directory: "/work-a" });

    assert.deepEqual(listCalls, [["/work-a", "/work-b"]]);
    assert.deepEqual(
      snapshot.board.cards.map((card) => card.sessionId).sort(),
      ["b-session", "session-9"]
    );
    // ウォーターマークは全候補の最大updatedAt。
    assert.equal(
      snapshot.board.ingestedUpdatedAtMs,
      new Date("2026-06-09T00:00:00.000Z").getTime()
    );
  }, { sessionsByDirectory });
});

test("concurrent sweeps merge into a single listing", async () => {
  await withHarness(async ({ service, ingest, listCalls }) => {
    await service.syncIngestDirectories({ directories: ["/work"] });
    const [first, second] = await Promise.all([
      ingest.sweep({ force: true }),
      ingest.sweep({ force: true }),
    ]);
    assert.equal(listCalls.length, 1);
    assert.equal(first, second);
  }, { sessionsByDirectory: { "/work": [candidate(1)] } });
});

test("ingest failures are contained and do not reject", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await withHarness(async ({ service, ingest }) => {
      await service.syncIngestDirectories({ directories: ["/work"] });
      const failing = createSkiaBoardIngest({
        boardService: service,
        listAgentSessionsForDirectories: async () => {
          throw new Error("backend not ready");
        },
        resolveDirectory: (value) => value,
        minSweepIntervalMs: 0,
      });
      assert.equal(await failing.sweep({ force: true }), null);
      assert.equal(await failing.onTurnCompleted({ directory: "/work" }), null);
      assert.equal(ingest !== null, true);
    });
  } finally {
    console.warn = originalWarn;
  }
});
