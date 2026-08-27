// Skiaボード状態のHTTPハンドラ。server-runtime のif連鎖から1行で差し込む。
// 認証・ボディ読取・JSON応答は server-runtime のヘルパーを注入して使う。

import {
  SkiaBoardAlreadyInitializedError,
  SkiaBoardNotInitializedError,
  SkiaBoardRevisionConflictError,
  SkiaBoardStoreUnavailableError,
} from "./skia-board-service.mjs";

const OPS_BODY_MAX_BYTES = 128 * 1024;
// 引き継ぎはボード全体を運ぶため、opより大きい上限にする。
const IMPORT_BODY_MAX_BYTES = 512 * 1024;
const INGEST_DIRECTORIES_BODY_MAX_BYTES = 32 * 1024;

function message(error) {
  return String(error instanceof Error ? error.message : error || "unknown error");
}

export function createSkiaBoardHttpHandler({
  service,
  ingest = null,
  runnerToken,
  parseAuthToken,
  readJsonBody,
  json,
}) {
  const routes = {
    "/skia-board": {
      method: "GET",
      maxBytes: 0,
      handle: async () => {
        // 補完スイープ: ランナーを経由せず作られたセッションをボードへ取り込んでから返す。
        // スロットルと失敗の握り込みは ingest 側が持つ。
        if (ingest) await ingest.sweep();
        return service.getBoard();
      },
    },
    "/skia-board/ops": {
      method: "POST",
      maxBytes: OPS_BODY_MAX_BYTES,
      handle: (body) => service.applyOps(body),
    },
    "/skia-board/import": {
      method: "POST",
      maxBytes: IMPORT_BODY_MAX_BYTES,
      handle: (body) => service.importBoard(body),
    },
    "/skia-board/ingest-directories": {
      method: "POST",
      maxBytes: INGEST_DIRECTORIES_BODY_MAX_BYTES,
      handle: (body) => service.syncIngestDirectories(body),
    },
  };

  return async function handleSkiaBoard(req, res, pathname) {
    const route = routes[pathname];
    if (!route) return false;

    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return true;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== route.method) {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }

    try {
      const body = route.method === "GET" ? undefined : await readJsonBody(req, route.maxBytes);
      json(res, 200, await route.handle(body));
    } catch (error) {
      if (error instanceof SkiaBoardRevisionConflictError) {
        json(res, 409, { error: "revision_conflict", ...error.snapshot });
      } else if (error instanceof SkiaBoardNotInitializedError) {
        json(res, 409, { error: "not_initialized", ...error.snapshot });
      } else if (error instanceof SkiaBoardAlreadyInitializedError) {
        json(res, 409, { error: "already_initialized", ...error.snapshot });
      } else if (error instanceof SkiaBoardStoreUnavailableError) {
        json(res, 503, { error: "skia_board_store_unavailable", message: message(error) });
      } else if (error instanceof SyntaxError) {
        json(res, 400, { error: "invalid_json", message: message(error) });
      } else if (message(error) === "request body is too large") {
        json(res, 400, { error: "request_body_too_large" });
      } else {
        json(res, 400, { error: "invalid_skia_board_request", message: message(error) });
      }
    }
    return true;
  };
}
