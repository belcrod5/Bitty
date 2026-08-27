import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSkiaBoardService,
  SkiaBoardAlreadyInitializedError,
  SkiaBoardNotInitializedError,
  SkiaBoardRevisionConflictError,
  SkiaBoardValidationError,
} from "../src/skia-board-service.mjs";

async function withTempStorePath(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skia-board-store-"));
  try {
    await fn(path.join(dir, "skia_board_state.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function importableBoard() {
  return {
    cards: [
      { kind: "session", sessionId: "session-1", col: 0, row: 0 },
      { kind: "file", rootDir: "/w", path: "a.md", col: 1, row: 0 },
    ],
    sections: [],
    excludedSessionIds: ["removed"],
    ingestedUpdatedAtMs: 1000,
    cardTextScale: 1.2,
  };
}

test("uninitialized store reports initialized: false and rejects ops", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    assert.deepEqual(await service.getBoard(), {
      initialized: false,
      revision: 0,
      origin: null,
      board: null,
    });
    await assert.rejects(
      service.applyOps({ baseRevision: 0, ops: [{ type: "tidyCards" }] }),
      SkiaBoardNotInitializedError
    );
  });
});

test("import initializes the store and drops app-local fields", async () => {
  await withTempStorePath(async (storePath) => {
    const events = [];
    const service = createSkiaBoardService({ storePath, broadcast: (payload) => events.push(payload) });
    const snapshot = await service.importBoard({ board: importableBoard() });
    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.origin, "import");
    assert.equal("cardTextScale" in snapshot.board, false);
    assert.deepEqual(snapshot.board.excludedSessionIds, ["removed"]);
    assert.deepEqual(events, [{ revision: 1 }]);

    // 別インスタンスで読み直しても同じ内容(永続化の検証)。
    const reloaded = createSkiaBoardService({ storePath });
    assert.deepEqual(await reloaded.getBoard(), snapshot);
  });
});

test("import rejects an empty board payload", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    await assert.rejects(service.importBoard({ board: { cards: [] } }), SkiaBoardValidationError);
    await assert.rejects(service.importBoard({}), SkiaBoardValidationError);
  });
});

test("import acceptance: overwrites untouched ingest data, rejects otherwise", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    // origin: "ingest" 相当のストアを直接用意する(ingest実装はStep 4)。
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      revision: 3,
      origin: "ingest",
      userEdited: false,
      initializedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      board: {
        cards: [{ kind: "session", sessionId: "auto-1", col: 0, row: 0 }],
        sections: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 10,
      },
      ingestDirectories: ["/work"],
    }));

    // 未編集のingest初期化は上書き受理。
    const imported = await service.importBoard({ board: importableBoard() });
    assert.equal(imported.origin, "import");
    assert.equal(imported.revision, 4);
    assert.equal(imported.board.cards[0].sessionId, "session-1");

    // import済みストアへの再importは409相当。
    await assert.rejects(
      service.importBoard({ board: importableBoard() }),
      (error) => {
        assert.ok(error instanceof SkiaBoardAlreadyInitializedError);
        assert.equal(error.snapshot.revision, 4);
        return true;
      }
    );
  });
});

test("import rejects an ingest store that has user edits", async () => {
  await withTempStorePath(async (storePath) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      revision: 5,
      origin: "ingest",
      userEdited: true,
      initializedAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      board: {
        cards: [{ kind: "session", sessionId: "auto-1", col: 2, row: 2 }],
        sections: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 10,
      },
      ingestDirectories: [],
    }));
    const service = createSkiaBoardService({ storePath });
    await assert.rejects(
      service.importBoard({ board: importableBoard() }),
      SkiaBoardAlreadyInitializedError
    );
  });
});

test("applyOps enforces the revision lock and marks user edits", async () => {
  await withTempStorePath(async (storePath) => {
    const events = [];
    const service = createSkiaBoardService({ storePath, broadcast: (payload) => events.push(payload) });
    await service.importBoard({ board: importableBoard() });

    await assert.rejects(
      service.applyOps({ baseRevision: 0, ops: [{ type: "tidyCards" }] }),
      (error) => {
        assert.ok(error instanceof SkiaBoardRevisionConflictError);
        assert.equal(error.snapshot.revision, 1);
        assert.ok(error.snapshot.board);
        return true;
      }
    );

    const moved = await service.applyOps({
      baseRevision: 1,
      ops: [
        { type: "moveCard", cardId: "session:session-1", col: 1, row: 3 },
        { type: "addCard", card: { kind: "directory", directory: "/repo" } },
      ],
    });
    assert.equal(moved.revision, 2);
    assert.equal(moved.board.cards.length, 3);
    assert.deepEqual(events, [{ revision: 1 }, { revision: 2 }]);

    // 変化しないopは revision を上げず、通知もしない。
    const unchanged = await service.applyOps({
      baseRevision: 2,
      ops: [{ type: "moveCard", cardId: "session:missing", col: 0, row: 0 }],
    });
    assert.equal(unchanged.revision, 2);
    assert.equal(events.length, 2);

    // userEdited が立ち、以後のimportは拒否される。
    const reloaded = createSkiaBoardService({ storePath });
    await assert.rejects(
      reloaded.importBoard({ board: importableBoard() }),
      SkiaBoardAlreadyInitializedError
    );
  });
});

test("applyOps validates the request shape", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    await service.importBoard({ board: importableBoard() });
    await assert.rejects(service.applyOps({ ops: [{ type: "tidyCards" }] }), SkiaBoardValidationError);
    await assert.rejects(service.applyOps({ baseRevision: 1, ops: [] }), SkiaBoardValidationError);
    await assert.rejects(
      service.applyOps({ baseRevision: 1, ops: [{ type: "explode" }] }),
      SkiaBoardValidationError
    );
  });
});

test("syncIngestDirectories merges as a union without bumping the revision", async () => {
  await withTempStorePath(async (storePath) => {
    const events = [];
    const service = createSkiaBoardService({ storePath, broadcast: (payload) => events.push(payload) });
    const first = await service.syncIngestDirectories({ directories: [" /a ", "/b", "/a", ""] });
    assert.deepEqual(first.ingestDirectories, ["/a", "/b"]);
    const second = await service.syncIngestDirectories({ directories: ["/b", "/c"] });
    assert.deepEqual(second.ingestDirectories, ["/a", "/b", "/c"]);
    const unchanged = await service.syncIngestDirectories({ directories: ["/a"] });
    assert.deepEqual(unchanged.ingestDirectories, ["/a", "/b", "/c"]);
    assert.deepEqual(events, []);
    assert.deepEqual(await service.getBoard(), {
      initialized: false,
      revision: 0,
      origin: null,
      board: null,
    });

    // 永続化され、別インスタンスへ引き継がれる。
    const raw = JSON.parse(await fs.readFile(storePath, "utf8"));
    assert.deepEqual(raw.ingestDirectories, ["/a", "/b", "/c"]);
    assert.equal(raw.revision, 0);
  });
});

test("a board emptied by ops survives a reload", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    await service.importBoard({
      board: {
        cards: [{ kind: "file", rootDir: "/w", path: "a.md", col: 0, row: 0 }],
        sections: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 0,
      },
    });
    const emptied = await service.applyOps({
      baseRevision: 1,
      ops: [{ type: "removeCard", cardId: "file:/w\na.md" }],
    });
    assert.deepEqual(emptied.board.cards, []);

    const reloaded = createSkiaBoardService({ storePath });
    const snapshot = await reloaded.getBoard();
    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.origin, "import");
    assert.deepEqual(snapshot.board.cards, []);
  });
});

test("a persist failure fails closed for later operations", async () => {
  await withTempStorePath(async (storePath) => {
    let failWrites = false;
    const fileSystem = {
      stat: (...args) => fs.stat(...args),
      readFile: (...args) => fs.readFile(...args),
      mkdir: (...args) => fs.mkdir(...args),
      unlink: (...args) => fs.unlink(...args),
      rename: (...args) => fs.rename(...args),
      writeFile: (...args) => {
        if (failWrites) return Promise.reject(new Error("disk full"));
        return fs.writeFile(...args);
      },
    };
    const service = createSkiaBoardService({ storePath, fileSystem });
    failWrites = true;
    await assert.rejects(
      service.importBoard({ board: importableBoard() }),
      /failed to persist/
    );
    failWrites = false;
    await assert.rejects(service.getBoard(), /failed to persist/);
  });
});

test("concurrent applyOps serialize and both revisions advance", async () => {
  await withTempStorePath(async (storePath) => {
    const service = createSkiaBoardService({ storePath });
    await service.importBoard({ board: importableBoard() });
    const [first, second] = await Promise.allSettled([
      service.applyOps({
        baseRevision: 1,
        ops: [{ type: "addCard", card: { kind: "directory", directory: "/one" } }],
      }),
      service.applyOps({
        baseRevision: 1,
        ops: [{ type: "addCard", card: { kind: "directory", directory: "/two" } }],
      }),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(first.value.revision, 2);
    // 直列化により2本目は古いbaseRevisionとなり409相当で弾かれる。
    assert.equal(second.status, "rejected");
    assert.ok(second.reason instanceof SkiaBoardRevisionConflictError);
    assert.equal(second.reason.snapshot.revision, 2);
  });
});

test("stored ingest directories are canonicalized on load", async () => {
  await withTempStorePath(async (storePath) => {
    // 旧バージョンが未正規化のまま保存したケースを再現する。
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      revision: 0,
      origin: null,
      userEdited: false,
      initializedAt: null,
      updatedAt: "2026-08-27T00:00:00.000Z",
      board: null,
      ingestDirectories: ["/var/work", "/private/var/work", "/unresolvable"],
    }));
    const service = createSkiaBoardService({
      storePath,
      normalizeDirectory: (value) => {
        if (value === "/unresolvable") throw new Error("ENOENT-ish");
        return value.replace(/^\/var\//, "/private/var/");
      },
    });
    assert.deepEqual(await service.getIngestDirectories(), [
      "/private/var/work",
      "/unresolvable",
    ]);
  });
});

test("a corrupted store fails closed instead of reinitializing", async () => {
  await withTempStorePath(async (storePath) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{not json");
    const service = createSkiaBoardService({ storePath });
    await assert.rejects(service.getBoard(), /failed to parse/);
    await assert.rejects(service.importBoard({ board: importableBoard() }), /failed to parse/);
  });
});
