import {
  parseSkiaBoardState,
  SKIA_BOARD_DEFAULT_TEXT_SCALE,
  type SkiaBoardState,
} from "./skiaBoardState";
import type { SkiaBoardOp } from "./skiaBoardRunnerOps";

// ランナーのSkiaボードAPI(GET /skia-board、POST /skia-board/{ops,import})の薄いクライアント。
// fetchUnreadSessionCounts(sessionUnreadState.ts)と同じフック非依存の純関数スタイル。
// Cloudflare Accessヘッダは configureCloudflareAccessFetch が global fetch へ自動付与する。

const SKIA_BOARD_FETCH_TIMEOUT_MS = 15_000;

export type SkiaBoardRunnerSnapshot = {
  initialized: boolean;
  revision: number;
  board: SkiaBoardState | null;
};

export type SkiaBoardOpsResult =
  | { status: "ok"; snapshot: SkiaBoardRunnerSnapshot }
  | { status: "conflict"; snapshot: SkiaBoardRunnerSnapshot }
  | { status: "not_initialized"; snapshot: SkiaBoardRunnerSnapshot };

export type SkiaBoardImportResult =
  | { status: "ok"; snapshot: SkiaBoardRunnerSnapshot }
  | { status: "already_initialized"; snapshot: SkiaBoardRunnerSnapshot };

type RunnerAuth = { runnerUrl: string; runnerToken: string };

function requireAuth({ runnerUrl, runnerToken }: RunnerAuth): { baseUrl: string; token: string } {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  return { baseUrl, token };
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SKIA_BOARD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return {
      status: response.status,
      data: data && typeof data === "object" ? data as Record<string, unknown> : {},
    };
  } finally {
    clearTimeout(timer);
  }
}

// サーバーのboardをアプリのSkiaBoardStateへ写す。サーバーは cardTextScale を持たないため
// 既定値を補う(表示時にはローカル設定で上書きされる)。空ボードも有効なスナップショット。
function boardFromRaw(raw: unknown): SkiaBoardState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = parseSkiaBoardState(raw);
  if (parsed) return parsed;
  return {
    cards: [],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: SKIA_BOARD_DEFAULT_TEXT_SCALE,
  };
}

function snapshotFromData(data: Record<string, unknown>): SkiaBoardRunnerSnapshot {
  const revision = Number(data.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("Runnerから正しいボードrevisionが返されませんでした");
  }
  const board = boardFromRaw(data.board);
  const initialized = data.initialized === undefined ? board !== null : data.initialized === true;
  return { initialized, revision, board: initialized ? board : null };
}

function errorMessage(data: Record<string, unknown>, status: number): string {
  return String(data.message || data.error || `HTTP ${status}`);
}

export async function fetchSkiaBoard(auth: RunnerAuth): Promise<SkiaBoardRunnerSnapshot> {
  const { baseUrl, token } = requireAuth(auth);
  const { status, data } = await fetchJson(`${baseUrl}/skia-board`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (status !== 200) throw new Error(errorMessage(data, status));
  return snapshotFromData(data);
}

export async function postSkiaBoardOps(
  auth: RunnerAuth,
  { baseRevision, ops }: { baseRevision: number; ops: readonly SkiaBoardOp[] }
): Promise<SkiaBoardOpsResult> {
  const { baseUrl, token } = requireAuth(auth);
  const { status, data } = await fetchJson(`${baseUrl}/skia-board/ops`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ baseRevision, ops }),
  });
  if (status === 200) return { status: "ok", snapshot: snapshotFromData(data) };
  if (status === 409 && data.error === "revision_conflict") {
    return { status: "conflict", snapshot: snapshotFromData(data) };
  }
  if (status === 409 && data.error === "not_initialized") {
    return { status: "not_initialized", snapshot: snapshotFromData(data) };
  }
  throw new Error(errorMessage(data, status));
}

// ボードに配置済みのセッションカードの表示情報を、ドロワーの取得ウィンドウに
// 依存せず直接取得する(POST /session-summaries、directory必須・100件バッチ)。
export const SKIA_BOARD_SESSION_SUMMARY_BATCH_SIZE = 100;

export type SkiaBoardSessionSummary = {
  sessionId: string;
  directory: string;
  cwd: string;
  updatedAt: string;
  lastReadAt: string;
  source: string;
  firstUserMessage: string;
  parentSessionId: string;
  contextUsage: unknown;
  modelRef: string;
  reasoningEffort: string;
};

export async function fetchSkiaBoardSessionSummaries(
  auth: RunnerAuth,
  { directory, sessionIds }: { directory: string; sessionIds: readonly string[] }
): Promise<SkiaBoardSessionSummary[]> {
  const { baseUrl, token } = requireAuth(auth);
  const results: SkiaBoardSessionSummary[] = [];
  for (
    let start = 0;
    start < sessionIds.length;
    start += SKIA_BOARD_SESSION_SUMMARY_BATCH_SIZE
  ) {
    const batch = sessionIds.slice(start, start + SKIA_BOARD_SESSION_SUMMARY_BATCH_SIZE);
    const { status, data } = await fetchJson(`${baseUrl}/session-summaries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ directory, sessionIds: batch }),
    });
    if (status !== 200) throw new Error(errorMessage(data, status));
    for (const raw of Array.isArray(data.sessions) ? data.sessions : []) {
      const record = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      const sessionId = String(record.sessionId || "").trim();
      if (!sessionId) continue;
      results.push({
        sessionId,
        directory: String(record.directory || directory),
        cwd: String(record.cwd || ""),
        updatedAt: String(record.updatedAt || ""),
        lastReadAt: String(record.lastReadAt || ""),
        source: String(record.source || ""),
        firstUserMessage: String(record.firstUserMessage || ""),
        parentSessionId: String(record.parentSessionId || ""),
        contextUsage: record.contextUsage ?? null,
        modelRef: String(record.modelRef || ""),
        reasoningEffort: String(record.reasoningEffort || ""),
      });
    }
  }
  return results;
}

// 各端末の登録ディレクトリをランナーへ送り、自動カード追加(ingest)の対象を
// 和集合で共有する。ボード内容は変わらないためrevisionは動かない。
export async function syncSkiaBoardIngestDirectories(
  auth: RunnerAuth,
  { directories }: { directories: readonly string[] }
): Promise<{ ingestDirectories: string[] }> {
  const { baseUrl, token } = requireAuth(auth);
  const { status, data } = await fetchJson(`${baseUrl}/skia-board/ingest-directories`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ directories }),
  });
  if (status !== 200) throw new Error(errorMessage(data, status));
  const ingestDirectories = Array.isArray(data.ingestDirectories)
    ? data.ingestDirectories.map((value) => String(value || ""))
    : [];
  return { ingestDirectories };
}

export async function importSkiaBoard(
  auth: RunnerAuth,
  { board }: { board: unknown }
): Promise<SkiaBoardImportResult> {
  const { baseUrl, token } = requireAuth(auth);
  const { status, data } = await fetchJson(`${baseUrl}/skia-board/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ board }),
  });
  if (status === 200) return { status: "ok", snapshot: snapshotFromData(data) };
  if (status === 409 && data.error === "already_initialized") {
    return { status: "already_initialized", snapshot: snapshotFromData(data) };
  }
  throw new Error(errorMessage(data, status));
}
