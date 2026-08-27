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
