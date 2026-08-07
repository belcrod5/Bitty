import type { RunnerSessionMessage } from "../hooks/useLlmSessionExplorer";
import { utf8ByteLength } from "../../ws/networkUsageMetrics";

// /session-messages の差分取得(sinceCursor)応答をローカルキャッシュへマージするための
// 純ロジック。ファイルIOやReact stateには依存しない(useSessionMessagesCacheController.ts が
// これらを組み合わせてメモリ+expo-file-system の2層キャッシュを提供する)。

// キャッシュフォーマットのバージョン。行スキーマやヘッダを変えるときはインクリメントする。
// 不一致のキャッシュは読み込まず破棄する(旧フォーマットのマイグレーションはしない)。
export const SESSION_MESSAGES_CACHE_VERSION = 1;
export const SESSION_MESSAGES_CACHE_DIR_NAME = "session-messages-cache";
export const SESSION_MESSAGES_CACHE_INDEX_FILE_NAME = "index.json";
// 容量とmoreAfter連鎖の上限。⑤(通信量計測)の結果に合わせてここだけ調整する。
export const SESSION_MESSAGES_CACHE_MAX_SESSION_BYTES = 512 * 1024;
export const SESSION_MESSAGES_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
// moreAfter連鎖はサーバー側走査が毎回O(n)のため、上限超過時は全文取得に切り替える。
export const SESSION_MESSAGES_CACHE_MAX_DELTA_CHAIN = 3;
export const SESSION_MESSAGES_CACHE_WRITE_DEBOUNCE_MS = 1_000;

export type CachedSessionMessages = {
  rows: RunnerSessionMessage[];
  // 前回応答の latestCursor。次回フェッチで sinceCursor に渡す。
  latestCursor: string;
  // 全文取得時に得た olderCursor(古い方向のページング用)。トリムで古い行を破棄したら
  // キャッシュ内の最古行とカーソル位置がずれるため null に無効化する。
  olderCursor: string | null;
};

export type SessionCacheIndexEntry = {
  bytes: number;
  lastAccessAtMs: number;
  updatedAtMs: number;
};

export type SessionCacheIndex = {
  version: number;
  sessions: Record<string, SessionCacheIndexEntry>;
};

// sessionIdはそのままキャッシュファイル名になるため、パス区切りなどを含むIDは
// キャッシュ対象外にする(実際のIDはUUID形式)。
export function isCacheSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId) && !sessionId.includes("..");
}

function rowByteLength(row: RunnerSessionMessage): number {
  return utf8ByteLength(JSON.stringify(row)) + 1;
}

export function estimateSessionRowsBytes(rows: RunnerSessionMessage[]): number {
  let total = 0;
  for (const row of rows) total += rowByteLength(row);
  return total;
}

// 差分応答の行をキャッシュ済み行へマージする。
// - `replacesItemId` 付き: 旧行(itemId一致)をその位置で新行に置換(=削除+挿入)。
// - itemId がキャッシュ済み行と一致: その行を置換(境界またぎのペア確定・コマンド結果反映)。
// - それ以外: 末尾に追記(差分応答は古→新昇順)。
// 保存行には replacesItemId を残さない(再マージ時の誤削除防止)。
export function mergeSessionMessageRows(
  cachedRows: RunnerSessionMessage[],
  deltaRows: RunnerSessionMessage[],
): RunnerSessionMessage[] {
  const rows = [...cachedRows];
  const indexByItemId = new Map<string, number>();
  rows.forEach((row, index) => {
    const itemId = String(row.itemId || "").trim();
    if (itemId) indexByItemId.set(itemId, index);
  });
  const replaceAt = (index: number, row: RunnerSessionMessage) => {
    const previousItemId = String(rows[index]?.itemId || "").trim();
    if (previousItemId) indexByItemId.delete(previousItemId);
    rows[index] = row;
    const nextItemId = String(row.itemId || "").trim();
    if (nextItemId) indexByItemId.set(nextItemId, index);
  };
  for (const deltaRow of deltaRows) {
    const { replacesItemId, ...rowWithoutMarker } = deltaRow;
    const row: RunnerSessionMessage = rowWithoutMarker;
    const replacedItemId = String(replacesItemId || "").trim();
    if (replacedItemId) {
      const replacedIndex = indexByItemId.get(replacedItemId);
      if (typeof replacedIndex === "number") {
        replaceAt(replacedIndex, row);
        continue;
      }
      // 旧行がキャッシュ範囲外(トリム済み等)なら通常の置換/追記にフォールバック。
    }
    const itemId = String(row.itemId || "").trim();
    const existingIndex = itemId ? indexByItemId.get(itemId) : undefined;
    if (typeof existingIndex === "number") {
      replaceAt(existingIndex, row);
      continue;
    }
    rows.push(row);
    if (itemId) indexByItemId.set(itemId, rows.length - 1);
  }
  return rows;
}

export type TrimSessionRowsResult = {
  rows: RunnerSessionMessage[];
  bytes: number;
  trimmed: boolean;
};

// セッション上限を超えたら古い行から破棄する。最低1行は残す(1行で超過するほど巨大な
// 行はそのまま保持し、全体LRUに任せる)。
export function trimSessionRows(
  rows: RunnerSessionMessage[],
  maxBytes: number,
): TrimSessionRowsResult {
  const sizes = rows.map(rowByteLength);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let startIndex = 0;
  while (total > maxBytes && startIndex < rows.length - 1) {
    total -= sizes[startIndex];
    startIndex += 1;
  }
  if (startIndex <= 0) return { rows, bytes: total, trimmed: false };
  return { rows: rows.slice(startIndex), bytes: total, trimmed: true };
}

type SessionCacheFileHeader = {
  v: number;
  sessionId: string;
  latestCursor: string;
  olderCursor: string | null;
  savedAtMs: number;
};

// <sessionId>.jsonl のフォーマット: 1行目がヘッダJSON、2行目以降が1行1 RunnerSessionMessage。
export function serializeSessionCacheFile(
  sessionId: string,
  cache: CachedSessionMessages,
  savedAtMs: number,
): string {
  const header: SessionCacheFileHeader = {
    v: SESSION_MESSAGES_CACHE_VERSION,
    sessionId,
    latestCursor: cache.latestCursor,
    olderCursor: cache.olderCursor,
    savedAtMs,
  };
  const lines = [JSON.stringify(header)];
  for (const row of cache.rows) lines.push(JSON.stringify(row));
  return lines.join("\n");
}

function parseCachedRow(raw: unknown): RunnerSessionMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const role = String(item.role || "").trim().toLowerCase();
  if (role !== "user" && role !== "assistant") return null;
  const content = String(item.content ?? "");
  const commandRaw = item.commandExecution && typeof item.commandExecution === "object"
    ? item.commandExecution as Record<string, unknown>
    : null;
  const commandExecution = commandRaw
    ? {
      command: String(commandRaw.command || "").trim(),
      status: commandRaw.status === "failed"
        ? "failed" as const
        : commandRaw.status === "running"
          ? "running" as const
          : "completed" as const,
      exitCode: Number.isFinite(Number(commandRaw.exitCode)) ? Number(commandRaw.exitCode) : null,
    }
    : undefined;
  return {
    role: role as RunnerSessionMessage["role"],
    content,
    at: String(item.at || "").trim(),
    ...(item.kind === "internal_context" || item.kind === "unclassified_context"
      ? { kind: item.kind }
      : {}),
    itemId: String(item.itemId || "").trim() || undefined,
    inheritedFromParent: item.inheritedFromParent === true || undefined,
    commandExecution,
  };
}

// 破損・version不一致・セッション不一致はすべて null(=キャッシュ破棄)を返す。
export function parseSessionCacheFile(
  text: string,
  expectedSessionId: string,
): CachedSessionMessages | null {
  const lines = String(text || "").split("\n");
  if (lines.length <= 0) return null;
  let header: SessionCacheFileHeader;
  try {
    header = JSON.parse(lines[0]) as SessionCacheFileHeader;
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  if (Number(header.v) !== SESSION_MESSAGES_CACHE_VERSION) return null;
  if (String(header.sessionId || "") !== expectedSessionId) return null;
  const latestCursor = String(header.latestCursor || "").trim();
  if (!latestCursor) return null;
  const rows: RunnerSessionMessage[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 途中で切れたファイル(クラッシュ等)は安全側で丸ごと破棄する。
      return null;
    }
    const row = parseCachedRow(parsed);
    if (!row) return null;
    rows.push(row);
  }
  if (rows.length <= 0) return null;
  return {
    rows,
    latestCursor,
    olderCursor: String(header.olderCursor || "").trim() || null,
  };
}

export function createEmptySessionCacheIndex(): SessionCacheIndex {
  return { version: SESSION_MESSAGES_CACHE_VERSION, sessions: {} };
}

export function serializeSessionCacheIndex(index: SessionCacheIndex): string {
  return JSON.stringify(index);
}

// version不一致・破損は null(=ディレクトリごと破棄してやり直し)を返す。
export function parseSessionCacheIndex(text: string): SessionCacheIndex | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Number(record.version) !== SESSION_MESSAGES_CACHE_VERSION) return null;
  const sessionsRaw = record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)
    ? record.sessions as Record<string, unknown>
    : {};
  const sessions: Record<string, SessionCacheIndexEntry> = {};
  for (const [sessionId, entryRaw] of Object.entries(sessionsRaw)) {
    if (!isCacheSafeSessionId(sessionId)) continue;
    const entry = entryRaw && typeof entryRaw === "object" ? entryRaw as Record<string, unknown> : {};
    sessions[sessionId] = {
      bytes: Math.max(0, Number(entry.bytes) || 0),
      lastAccessAtMs: Math.max(0, Number(entry.lastAccessAtMs) || 0),
      updatedAtMs: Math.max(0, Number(entry.updatedAtMs) || 0),
    };
  }
  return { version: SESSION_MESSAGES_CACHE_VERSION, sessions };
}

// 全体上限を超えたときに破棄するセッションを lastAccessAtMs の古い順(LRU)に選ぶ。
// protectedSessionIds は直近アクセス中のセッションで、最後まで残す。
export function selectSessionCacheEvictions(
  index: SessionCacheIndex,
  maxTotalBytes: number,
  protectedSessionIds: readonly string[] = [],
): string[] {
  const protectedSet = new Set(protectedSessionIds);
  const entries = Object.entries(index.sessions);
  let total = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
  if (total <= maxTotalBytes) return [];
  const evictable = entries
    .filter(([sessionId]) => !protectedSet.has(sessionId))
    .sort((left, right) => left[1].lastAccessAtMs - right[1].lastAccessAtMs);
  const evictions: string[] = [];
  for (const [sessionId, entry] of evictable) {
    if (total <= maxTotalBytes) break;
    evictions.push(sessionId);
    total -= entry.bytes;
  }
  return evictions;
}
