// Skiaボード状態のランナー側ストア。デバイス間で共有するボード配置の正本を
// logs/skia_board_state.json に持ち、revision楽観ロックで複数デバイスの同時編集を守る。
//
// - 差分op適用・引き継ぎ(import)・ingest対象ディレクトリの和集合同期を提供する
// - revision は「ボード内容」の単調カウンタ。ingestDirectories の変更はボード表示に
//   影響しないため revision を上げない(opの楽観ロックを無駄に失敗させない)
// - 読み書きの失敗はフェイルクローズ(以後 unavailable エラー)。ユーザーの配置データを
//   壊れた読み取り結果で上書きしない
// - 空ストアの自動初期化はしない。origin は "import"(アプリからの引き継ぎ) または
//   "ingest"(ランナー自動生成) で、引き継ぎの受理判定に使う

import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as defaultFileSystem } from "node:fs";
import {
  addSkiaBoardCard,
  emptySkiaBoardState,
  moveSkiaBoardCard,
  normalizeSkiaBoardState,
  parseSkiaBoardState,
  removeSkiaBoardCard,
  removeSkiaBoardSectionById,
  renameSkiaBoardFileCard,
  setSkiaBoardFileCardUnavailable,
  tidySkiaBoardCards,
  updateSkiaBoardCardAppearance,
  upsertSkiaBoardSection,
} from "./skia-board-logic.mjs";

export const SKIA_BOARD_STORE_MAX_BYTES = 4 * 1024 * 1024;
export const SKIA_BOARD_MAX_OPS_PER_REQUEST = 100;
export const SKIA_BOARD_MAX_INGEST_DIRECTORIES = 100;

export class SkiaBoardRevisionConflictError extends Error {
  constructor(snapshot) {
    super("skia board revision conflict");
    this.name = "SkiaBoardRevisionConflictError";
    this.code = "SKIA_BOARD_REVISION_CONFLICT";
    this.snapshot = snapshot;
  }
}

export class SkiaBoardNotInitializedError extends Error {
  constructor(snapshot) {
    super("skia board is not initialized");
    this.name = "SkiaBoardNotInitializedError";
    this.code = "SKIA_BOARD_NOT_INITIALIZED";
    this.snapshot = snapshot;
  }
}

export class SkiaBoardAlreadyInitializedError extends Error {
  constructor(snapshot) {
    super("skia board is already initialized");
    this.name = "SkiaBoardAlreadyInitializedError";
    this.code = "SKIA_BOARD_ALREADY_INITIALIZED";
    this.snapshot = snapshot;
  }
}

export class SkiaBoardStoreUnavailableError extends Error {
  constructor(message) {
    super(message || "skia board store is unavailable");
    this.name = "SkiaBoardStoreUnavailableError";
    this.code = "SKIA_BOARD_STORE_UNAVAILABLE";
  }
}

export class SkiaBoardValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkiaBoardValidationError";
    this.code = "SKIA_BOARD_INVALID_REQUEST";
  }
}

function normalizeIngestDirectories(rawList) {
  return Array.from(new Set(
    (Array.isArray(rawList) ? rawList : [])
      .map((value) => String(value || "").trim())
      .filter((value) => !!value)
  )).slice(0, SKIA_BOARD_MAX_INGEST_DIRECTORIES);
}

const OP_APPLIERS = {
  moveCard: (board, op) => moveSkiaBoardCard(
    board,
    String(op.cardId || ""),
    op.col,
    op.row
  ),
  addCard: (board, op) => addSkiaBoardCard(board, op.card),
  removeCard: (board, op) => removeSkiaBoardCard(board, String(op.cardId || "")),
  upsertSection: (board, op) => upsertSkiaBoardSection(board, op.section),
  removeSection: (board, op) => removeSkiaBoardSectionById(board, op.sectionId),
  updateCardAppearance: (board, op) => updateSkiaBoardCardAppearance(
    board,
    String(op.cardId || ""),
    { displayNameOverride: op.displayNameOverride, imagePath: op.imagePath }
  ),
  renameFileCard: (board, op) => renameSkiaBoardFileCard(
    board,
    String(op.rootDir || ""),
    String(op.previousPath || ""),
    String(op.nextPath || "")
  ),
  setFileCardUnavailable: (board, op) => setSkiaBoardFileCardUnavailable(
    board,
    String(op.rootDir || ""),
    String(op.path || ""),
    op.unavailable
  ),
  tidyCards: (board, op) => tidySkiaBoardCards(
    board,
    op.visibleCardIds === undefined ? undefined : op.visibleCardIds
  ),
};

export function createSkiaBoardService({
  storePath,
  now = () => new Date(),
  fileSystem = defaultFileSystem,
  broadcast = () => {},
} = {}) {
  if (!storePath) throw new Error("storePath is required");

  // メモリ常駐の正本。origin === null の間は未初期化(引き継ぎ待ち)。
  let store = null;
  let loadPromise = null;
  let mutationQueue = Promise.resolve();
  let unavailableReason = "";

  function storeError(message, cause) {
    unavailableReason = `${message}${cause ? `: ${String(cause?.message || cause)}` : ""}`;
    return new SkiaBoardStoreUnavailableError(unavailableReason);
  }

  function freshStore() {
    return {
      revision: 0,
      origin: null,
      userEdited: false,
      initializedAt: null,
      board: null,
      ingestDirectories: [],
    };
  }

  async function load() {
    let text;
    try {
      const stat = await fileSystem.stat(storePath);
      if (stat.size > SKIA_BOARD_STORE_MAX_BYTES) {
        throw storeError(`store file exceeds ${SKIA_BOARD_STORE_MAX_BYTES} bytes`);
      }
      text = await fileSystem.readFile(storePath, "utf8");
    } catch (error) {
      if (error instanceof SkiaBoardStoreUnavailableError) throw error;
      if (error?.code === "ENOENT") {
        store = freshStore();
        return;
      }
      throw storeError("failed to read skia board store", error);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw storeError("failed to parse skia board store", error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw storeError("skia board store root must be an object");
    }
    const revision = parsed.revision;
    if (!Number.isInteger(revision) || revision < 0) {
      throw storeError("skia board store revision must be a non-negative integer");
    }
    const origin = parsed.origin === "import" || parsed.origin === "ingest" ? parsed.origin : null;
    // 初期化済みなのにボードが読めない場合は、空で上書きせずフェイルクローズする。
    if (origin && (!parsed.board || typeof parsed.board !== "object" || Array.isArray(parsed.board))) {
      throw storeError("skia board store board payload is invalid");
    }
    store = {
      revision,
      origin,
      userEdited: parsed.userEdited === true,
      initializedAt: typeof parsed.initializedAt === "string" ? parsed.initializedAt : null,
      board: origin ? normalizeSkiaBoardState(parsed.board) : null,
      ingestDirectories: normalizeIngestDirectories(parsed.ingestDirectories),
    };
  }

  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = load().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  async function persist(nextStore) {
    const payload = {
      version: 1,
      revision: nextStore.revision,
      origin: nextStore.origin,
      userEdited: nextStore.userEdited,
      initializedAt: nextStore.initializedAt,
      updatedAt: now().toISOString(),
      board: nextStore.board,
      ingestDirectories: nextStore.ingestDirectories,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (Buffer.byteLength(text) > SKIA_BOARD_STORE_MAX_BYTES) {
      throw new SkiaBoardValidationError(
        `skia board state exceeds ${SKIA_BOARD_STORE_MAX_BYTES} bytes`
      );
    }
    let temporaryPath = null;
    try {
      await fileSystem.mkdir(path.dirname(storePath), { recursive: true });
      temporaryPath = `${storePath}.${randomUUID()}.tmp`;
      await fileSystem.writeFile(temporaryPath, text, "utf8");
      await fileSystem.rename(temporaryPath, storePath);
      temporaryPath = null;
    } catch (error) {
      if (temporaryPath) {
        await fileSystem.unlink(temporaryPath).catch(() => {});
      }
      throw storeError("failed to persist skia board store", error);
    }
  }

  function serialize(operation) {
    const run = mutationQueue.then(async () => {
      if (unavailableReason) throw new SkiaBoardStoreUnavailableError(unavailableReason);
      await ensureLoaded();
      return operation();
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  function buildSnapshot() {
    return {
      initialized: store.origin !== null,
      revision: store.revision,
      origin: store.origin,
      board: store.board,
    };
  }

  async function commit(nextStore, { notify = true } = {}) {
    await persist(nextStore);
    store = nextStore;
    if (notify) broadcast({ revision: store.revision });
  }

  async function getBoard() {
    if (unavailableReason) throw new SkiaBoardStoreUnavailableError(unavailableReason);
    await ensureLoaded();
    return buildSnapshot();
  }

  function validateOps(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SkiaBoardValidationError("request body must be an object");
    }
    if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
      throw new SkiaBoardValidationError("baseRevision must be a non-negative integer");
    }
    if (!Array.isArray(body.ops) || body.ops.length <= 0) {
      throw new SkiaBoardValidationError("ops must be a non-empty array");
    }
    if (body.ops.length > SKIA_BOARD_MAX_OPS_PER_REQUEST) {
      throw new SkiaBoardValidationError(
        `ops must contain at most ${SKIA_BOARD_MAX_OPS_PER_REQUEST} entries`
      );
    }
    for (const [index, op] of body.ops.entries()) {
      if (!op || typeof op !== "object" || Array.isArray(op)) {
        throw new SkiaBoardValidationError(`ops[${index}] must be an object`);
      }
      if (!OP_APPLIERS[op.type]) {
        throw new SkiaBoardValidationError(`ops[${index}] has unknown type: ${String(op.type || "")}`);
      }
    }
  }

  function applyOps(body) {
    return serialize(async () => {
      validateOps(body);
      if (store.origin === null) throw new SkiaBoardNotInitializedError(buildSnapshot());
      if (body.baseRevision !== store.revision) {
        throw new SkiaBoardRevisionConflictError(buildSnapshot());
      }
      let board = store.board;
      for (const op of body.ops) {
        board = OP_APPLIERS[op.type](board, op);
      }
      if (board === store.board) return buildSnapshot();
      await commit({
        ...store,
        revision: store.revision + 1,
        userEdited: true,
        board,
      });
      return buildSnapshot();
    });
  }

  // アプリからのボード引き継ぎ。ユーザーが編集したボードを自動生成で上書きしない:
  // 1) 未初期化 → 受理  2) ingest初期化のみ(未編集) → 受理して上書き  3) それ以外 → 409
  function importBoard(body) {
    return serialize(async () => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new SkiaBoardValidationError("request body must be an object");
      }
      const board = parseSkiaBoardState(body.board);
      if (!board) throw new SkiaBoardValidationError("board must be a non-empty board state");
      const acceptable = store.origin === null
        || (store.origin === "ingest" && !store.userEdited);
      if (!acceptable) throw new SkiaBoardAlreadyInitializedError(buildSnapshot());
      await commit({
        ...store,
        revision: store.revision + 1,
        origin: "import",
        userEdited: false,
        initializedAt: now().toISOString(),
        board,
      });
      return buildSnapshot();
    });
  }

  // 各端末の登録ディレクトリを和集合でマージする(ingest対象の正本づくり)。
  // ボード内容は変わらないため revision は上げず、通知もしない。
  function syncIngestDirectories(body) {
    return serialize(async () => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new SkiaBoardValidationError("request body must be an object");
      }
      if (!Array.isArray(body.directories)) {
        throw new SkiaBoardValidationError("directories must be an array");
      }
      const additions = normalizeIngestDirectories(body.directories)
        .filter((directory) => !store.ingestDirectories.includes(directory));
      if (additions.length <= 0) {
        return { ingestDirectories: store.ingestDirectories };
      }
      const merged = [...store.ingestDirectories, ...additions]
        .slice(0, SKIA_BOARD_MAX_INGEST_DIRECTORIES);
      await commit({ ...store, ingestDirectories: merged }, { notify: false });
      return { ingestDirectories: store.ingestDirectories };
    });
  }

  return {
    getBoard,
    applyOps,
    importBoard,
    syncIngestDirectories,
  };
}
