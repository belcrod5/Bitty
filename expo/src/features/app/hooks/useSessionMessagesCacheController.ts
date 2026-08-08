import * as FileSystem from "expo-file-system/legacy";
import { useRef } from "react";
import { parseOptionalSessionId } from "../utils/llmSession";
import {
  createEmptySessionCacheIndex,
  isCacheSafeSessionId,
  mergeSessionMessageRows,
  parseSessionCacheFile,
  parseSessionCacheIndex,
  selectSessionCacheEvictions,
  serializeSessionCacheFile,
  serializeSessionCacheIndex,
  SESSION_MESSAGES_CACHE_DIR_NAME,
  SESSION_MESSAGES_CACHE_INDEX_FILE_NAME,
  SESSION_MESSAGES_CACHE_MAX_DELTA_CHAIN,
  SESSION_MESSAGES_CACHE_MAX_SESSION_BYTES,
  SESSION_MESSAGES_CACHE_MAX_TOTAL_BYTES,
  SESSION_MESSAGES_CACHE_WRITE_DEBOUNCE_MS,
  trimSessionRows,
  type SessionCacheIndex,
} from "../utils/sessionMessagesCache";
import {
  inferLatestToolLabelFromSessionMessages,
  type RunnerSessionMessage,
  type RunnerSessionMessagesResult,
} from "./useLlmSessionExplorer";

// /session-messages のメモリ+ファイル2層キャッシュ。全文フェッチをラップし、キャッシュが
// あるときは sinceCursor 差分だけ取得してローカルの行にマージする。
// - 保存するのは生の RunnerSessionMessage 行のみ(ConversationMessage は保存しない)。
// - メタ(contextUsage/runningTurn/updatedAt/modelRef 等)はキャッシュから出さず、毎回
//   サーバー応答の値を使う。キャッシュヒットでもサーバー往復は必ず1回以上行うので、
//   既存の freshness 判定・reconcile はフェッチ層の外でそのまま機能する。
// - 差分経路の失敗(409・ネットワークエラー・moreAfter連鎖上限超過)はすべて全文取得へ
//   フォールバックし、それも失敗した場合のみ従来どおりエラーを投げる。

export type FetchRunnerSessionMessagesFn = (
  sessionIdRaw: unknown,
  directoryRaw?: unknown,
  options?: { cursor?: string; sinceCursor?: string; skipLiveState?: boolean },
) => Promise<RunnerSessionMessagesResult>;

type SessionDiagLogFn = (event: string, payload?: Record<string, unknown>) => void;

export type SessionMessagesCacheControllerDeps = {
  fetchSessionMessages: FetchRunnerSessionMessagesFn;
  onSessionDiagLog?: SessionDiagLogFn;
  now?: () => number;
  // テスト用オーバーライド。プロダクションは sessionMessagesCache.ts の定数を使う。
  maxSessionBytes?: number;
  maxTotalBytes?: number;
  maxDeltaChains?: number;
  writeDebounceMs?: number;
};

export type SessionMessagesCacheController = {
  fetchRunnerSessionMessagesCached: (
    sessionIdRaw: unknown,
    directoryRaw?: unknown,
    options?: { cursor?: string },
  ) => Promise<RunnerSessionMessagesResult>;
  // デバウンス中の書き込みを即時反映する(テスト・診断用)。
  flushPendingWrites: () => Promise<void>;
};

type MemoryEntry = {
  rows: RunnerSessionMessage[];
  latestCursor: string;
  olderCursor: string | null;
  // トリム済み(古い行破棄済み)エントリ。次のセッションオープンで全文取得に切り替えて
  // olderCursorを取り直す(キャッシュ生存中olderページング不能が続くのを防ぐ)。
  trimmed: boolean;
  updatedAtMs: number;
  bytes: number;
};

const DISCARD_ERROR_CODES = new Set([
  "stale_history_cursor",
  "invalid_history_cursor",
  "conflicting_history_cursor",
  "restored_session_mismatch",
]);

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code || "").trim();
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeCodedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function createSessionMessagesCacheController(
  deps: SessionMessagesCacheControllerDeps,
): SessionMessagesCacheController {
  const now = deps.now ?? Date.now;
  const maxSessionBytes = deps.maxSessionBytes ?? SESSION_MESSAGES_CACHE_MAX_SESSION_BYTES;
  const maxTotalBytes = deps.maxTotalBytes ?? SESSION_MESSAGES_CACHE_MAX_TOTAL_BYTES;
  const maxDeltaChains = deps.maxDeltaChains ?? SESSION_MESSAGES_CACHE_MAX_DELTA_CHAIN;
  const writeDebounceMs = deps.writeDebounceMs ?? SESSION_MESSAGES_CACHE_WRITE_DEBOUNCE_MS;

  const entries = new Map<string, MemoryEntry>();
  let index: SessionCacheIndex | null = null;
  let indexDirty = false;
  let indexLoadPromise: Promise<void> | null = null;
  // 全ファイルIOを直列化するキュー(persistedSettingsFile.ts と同じパターン)。
  let ioQueue: Promise<unknown> = Promise.resolve();
  const pendingWrites = new Set<string>();
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  const diag: SessionDiagLogFn = (event, payload = {}) => {
    try {
      deps.onSessionDiagLog?.(event, payload);
    } catch {}
  };

  function cacheDirPath(): string | null {
    const base = FileSystem.cacheDirectory;
    if (!base) return null;
    return `${base}${SESSION_MESSAGES_CACHE_DIR_NAME}/`;
  }

  function enqueueIo<T>(op: () => Promise<T>): Promise<T> {
    const run = ioQueue.then(op);
    ioQueue = run.catch(() => {});
    return run;
  }

  async function writeIndexFile(dir: string) {
    if (!index) return;
    const path = `${dir}${SESSION_MESSAGES_CACHE_INDEX_FILE_NAME}`;
    const pendingPath = `${path}.pending`;
    await FileSystem.writeAsStringAsync(pendingPath, serializeSessionCacheIndex(index));
    await FileSystem.moveAsync({ from: pendingPath, to: path });
  }

  async function deleteSessionFile(dir: string, sessionId: string) {
    try {
      await FileSystem.deleteAsync(`${dir}${sessionId}.jsonl`, { idempotent: true });
    } catch {}
  }

  // 起動時(初回アクセス時)は index.json だけ読む。version不一致・破損はディレクトリごと
  // 破棄してやり直す。あわせて全体上限のLRU pruneと孤児ファイル掃除を行う。
  function ensureIndexLoaded(): Promise<void> {
    if (!indexLoadPromise) {
      indexLoadPromise = enqueueIo(async () => {
        const dir = cacheDirPath();
        if (!dir) {
          index = createEmptySessionCacheIndex();
          return;
        }
        try {
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        } catch {}
        const indexPath = `${dir}${SESSION_MESSAGES_CACHE_INDEX_FILE_NAME}`;
        let loaded: SessionCacheIndex | null = null;
        let hadIndexFile = false;
        try {
          const info = await FileSystem.getInfoAsync(indexPath);
          if (info.exists) {
            hadIndexFile = true;
            loaded = parseSessionCacheIndex(await FileSystem.readAsStringAsync(indexPath));
          }
        } catch {
          loaded = null;
        }
        if (hadIndexFile && !loaded) {
          // version不一致 or 破損: キャッシュ全体を破棄。
          diag("session_messages_cache_reset", { reason: "index_version_mismatch" });
          try {
            await FileSystem.deleteAsync(dir, { idempotent: true });
            await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          } catch {}
        }
        index = loaded ?? createEmptySessionCacheIndex();
        const evictions = selectSessionCacheEvictions(index, maxTotalBytes);
        for (const sessionId of evictions) {
          delete index.sessions[sessionId];
          await deleteSessionFile(dir, sessionId);
        }
        try {
          const names = await FileSystem.readDirectoryAsync(dir);
          for (const name of names) {
            // 書き込み途中にkillされた .pending は常にゴミ(pending→moveの2段書き込みで、
            // moveまで完了したファイルだけが有効)なので無条件に削除する。
            if (name.endsWith(".pending")) {
              try {
                await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
              } catch {}
              continue;
            }
            if (!name.endsWith(".jsonl")) continue;
            const sessionId = name.slice(0, -".jsonl".length);
            if (!index.sessions[sessionId]) {
              try {
                await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
              } catch {}
            }
          }
        } catch {}
        if (evictions.length > 0) {
          diag("session_messages_cache_pruned", { evictedCount: evictions.length, phase: "startup" });
          await writeIndexFile(dir);
        }
      }).catch((error) => {
        index = index ?? createEmptySessionCacheIndex();
        diag("session_messages_cache_index_load_failed", { message: errorMessage(error) });
      });
    }
    return indexLoadPromise;
  }

  function scheduleFlush() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flushPendingWrites();
    }, writeDebounceMs);
  }

  async function flushPendingWrites(): Promise<void> {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await ensureIndexLoaded();
    const dir = cacheDirPath();
    const sessionIds = [...pendingWrites];
    pendingWrites.clear();
    const wasDirty = indexDirty;
    indexDirty = false;
    if (!dir || !index || (sessionIds.length <= 0 && !wasDirty)) return;
    await enqueueIo(async () => {
      for (const sessionId of sessionIds) {
        const entry = entries.get(sessionId);
        if (!entry) continue;
        const path = `${dir}${sessionId}.jsonl`;
        const pendingPath = `${path}.pending`;
        await FileSystem.writeAsStringAsync(
          pendingPath,
          serializeSessionCacheFile(sessionId, entry, entry.updatedAtMs),
        );
        await FileSystem.moveAsync({ from: pendingPath, to: path });
      }
      const evictions = selectSessionCacheEvictions(index!, maxTotalBytes, sessionIds);
      for (const sessionId of evictions) {
        delete index!.sessions[sessionId];
        entries.delete(sessionId);
        await deleteSessionFile(dir, sessionId);
      }
      if (evictions.length > 0) {
        diag("session_messages_cache_pruned", { evictedCount: evictions.length, phase: "write" });
      }
      await writeIndexFile(dir);
    }).catch((error) => {
      // 失敗した書き込みは失わず戻す(次のupdateEntry/touch起点のflushで再試行される)。
      // ここでscheduleFlushはしない: 恒常的なIO障害でのリトライループを避ける。
      for (const sessionId of sessionIds) {
        if (entries.has(sessionId)) pendingWrites.add(sessionId);
      }
      indexDirty = indexDirty || wasDirty;
      diag("session_messages_cache_write_failed", { message: errorMessage(error) });
    });
  }

  function touchAccess(sessionId: string) {
    if (!index) return;
    const current = index.sessions[sessionId];
    if (!current) return;
    index.sessions[sessionId] = { ...current, lastAccessAtMs: now() };
    indexDirty = true;
    scheduleFlush();
  }

  async function loadEntry(sessionId: string): Promise<MemoryEntry | null> {
    await ensureIndexLoaded();
    const memory = entries.get(sessionId);
    if (memory) {
      touchAccess(sessionId);
      return memory;
    }
    if (!index?.sessions[sessionId]) return null;
    const dir = cacheDirPath();
    if (!dir) return null;
    const parsed = await enqueueIo(async () => {
      const path = `${dir}${sessionId}.jsonl`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return null;
      return parseSessionCacheFile(await FileSystem.readAsStringAsync(path), sessionId);
    }).catch(() => null);
    if (!parsed) {
      await discardEntry(sessionId, "cache_file_invalid");
      return null;
    }
    const indexEntry = index.sessions[sessionId];
    const entry: MemoryEntry = {
      rows: parsed.rows,
      latestCursor: parsed.latestCursor,
      olderCursor: parsed.olderCursor,
      trimmed: parsed.trimmed,
      updatedAtMs: indexEntry?.updatedAtMs || 0,
      bytes: indexEntry?.bytes || 0,
    };
    entries.set(sessionId, entry);
    touchAccess(sessionId);
    return entry;
  }

  function updateEntry(
    sessionId: string,
    rows: RunnerSessionMessage[],
    latestCursor: string,
    olderCursor: string | null,
  ) {
    const trimResult = trimSessionRows(rows, maxSessionBytes);
    const nowMs = now();
    const entry: MemoryEntry = {
      rows: trimResult.rows,
      latestCursor,
      // 古い行を破棄したらキャッシュ最古行とカーソル位置がずれるため olderCursor は無効化。
      olderCursor: trimResult.trimmed ? null : olderCursor,
      trimmed: trimResult.trimmed,
      updatedAtMs: nowMs,
      bytes: trimResult.bytes,
    };
    entries.set(sessionId, entry);
    if (index) {
      index.sessions[sessionId] = {
        bytes: entry.bytes,
        lastAccessAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    }
    pendingWrites.add(sessionId);
    indexDirty = true;
    scheduleFlush();
    if (trimResult.trimmed) {
      diag("session_messages_cache_trimmed", { sessionId, bytes: entry.bytes, rowCount: entry.rows.length });
    }
  }

  async function discardEntry(sessionId: string, reason: string) {
    entries.delete(sessionId);
    pendingWrites.delete(sessionId);
    if (index?.sessions[sessionId]) {
      delete index.sessions[sessionId];
      indexDirty = true;
      scheduleFlush();
    }
    diag("session_messages_cache_discarded", { sessionId, reason });
    const dir = cacheDirPath();
    if (!dir) return;
    await enqueueIo(async () => {
      await deleteSessionFile(dir, sessionId);
    }).catch(() => {});
  }

  function assertRestoredSessionMatches(sessionId: string, result: RunnerSessionMessagesResult) {
    const restoredSessionId = parseOptionalSessionId(result.threadId);
    if (restoredSessionId && restoredSessionId !== sessionId) {
      throw makeCodedError(
        "restored_session_mismatch",
        `restored session mismatch: requested=${sessionId} received=${restoredSessionId}`,
      );
    }
  }

  // キャッシュミス時・差分フォールバック時の全文取得。latestCursor が返る(=差分対応
  // サーバー)場合のみ結果をキャッシュへ保存する。
  async function fetchFullAndStore(
    sessionId: string,
    directoryRaw: unknown,
    reason: string,
  ): Promise<RunnerSessionMessagesResult> {
    const result = await deps.fetchSessionMessages(sessionId, directoryRaw);
    const restoredSessionId = parseOptionalSessionId(result.threadId);
    if (restoredSessionId && restoredSessionId !== sessionId) {
      // 呼び出し元(hydratePanelFromSessionHistory)が従来どおりmismatchを処理する。
      // ここではキャッシュだけ確実に消しておく。
      await discardEntry(sessionId, "restored_session_mismatch");
      return result;
    }
    const latestCursor = String(result.latestCursor || "").trim();
    if (!latestCursor) {
      // 旧サーバー(latestCursor無し): キャッシュを更新せず全量挙動のまま。
      diag("session_messages_cache_store_skipped", { sessionId, reason: "missing_latest_cursor" });
      return result;
    }
    if (result.messages.length <= 0) {
      // 空セッションは保存しない(0行ファイルはロード時に必ず破棄されるため、書き込み→
      // 破棄のチャーンになるだけ)。既存エントリが残っていれば空になったので消す。
      if (entries.has(sessionId) || index?.sessions[sessionId]) {
        await discardEntry(sessionId, "empty_session");
      }
      return result;
    }
    updateEntry(sessionId, result.messages, latestCursor, result.olderCursor);
    diag("session_messages_cache_stored", {
      sessionId,
      reason,
      rowCount: result.messages.length,
    });
    return result;
  }

  async function fetchDeltaAndMerge(
    sessionId: string,
    directoryRaw: unknown,
    entry: MemoryEntry,
  ): Promise<RunnerSessionMessagesResult> {
    const first = await deps.fetchSessionMessages(sessionId, directoryRaw, {
      sinceCursor: entry.latestCursor,
    });
    assertRestoredSessionMatches(sessionId, first);
    let mergedRows = mergeSessionMessageRows(entry.rows, first.messages);
    let deltaRowCount = first.messages.length;
    let last = first;
    let chains = 0;
    while (last.moreAfter === true) {
      const nextSinceCursor = String(last.latestCursor || "").trim();
      if (!nextSinceCursor || chains >= maxDeltaChains) {
        throw makeCodedError(
          "delta_chain_overflow",
          `delta chain exceeded ${maxDeltaChains} pages`,
        );
      }
      chains += 1;
      // 連鎖ページはメッセージ本文だけ必要なので、live状態のRPCは初回のみに抑える。
      last = await deps.fetchSessionMessages(sessionId, directoryRaw, {
        sinceCursor: nextSinceCursor,
        skipLiveState: true,
      });
      mergedRows = mergeSessionMessageRows(mergedRows, last.messages);
      deltaRowCount += last.messages.length;
    }
    const finalLatestCursor = String(last.latestCursor || "").trim();
    if (!finalLatestCursor) {
      // 差分応答は必ず latestCursor を返す契約。欠けたら全文取得へフォールバック。
      throw makeCodedError("missing_latest_cursor", "delta response missing latestCursor");
    }
    if (deltaRowCount > 0 || finalLatestCursor !== entry.latestCursor) {
      updateEntry(sessionId, mergedRows, finalLatestCursor, entry.olderCursor);
    } else {
      touchAccess(sessionId);
    }
    diag("session_messages_cache_hit", {
      sessionId,
      cachedRowCount: entry.rows.length,
      deltaRowCount,
      chains,
    });
    // メタ(contextUsage/modelRef/updatedAt等)は最後のサーバー応答、live系(runningTurn等)は
    // 初回応答の値を使う。messages はキャッシュとの結合結果(表示用にはトリム前を返す)。
    return {
      ...last,
      threadId: first.threadId || sessionId,
      threadStatusType: first.threadStatusType,
      hasRunningTurn: first.hasRunningTurn,
      runningTurn: first.runningTurn,
      ...(first.liveStatePromise ? { liveStatePromise: first.liveStatePromise } : {}),
      messages: mergedRows,
      latestToolLabel: inferLatestToolLabelFromSessionMessages({ messages: mergedRows })
        || last.latestToolLabel,
      olderCursor: entry.olderCursor,
      moreAfter: false,
    };
  }

  async function fetchRunnerSessionMessagesCached(
    sessionIdRaw: unknown,
    directoryRaw?: unknown,
    options?: { cursor?: string },
  ): Promise<RunnerSessionMessagesResult> {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    const cursor = String(options?.cursor || "").trim();
    // olderページング(cursor指定)とキャッシュ不能なIDは素通しで従来どおりサーバーへ。
    if (!sessionId || cursor || !isCacheSafeSessionId(sessionId)) {
      return deps.fetchSessionMessages(sessionIdRaw, directoryRaw, options);
    }
    let entry: MemoryEntry | null = null;
    try {
      entry = await loadEntry(sessionId);
    } catch {
      entry = null;
    }
    if (!entry || !entry.latestCursor || entry.rows.length <= 0) {
      diag("session_messages_cache_miss", { sessionId });
      return fetchFullAndStore(sessionId, directoryRaw, "cache_miss");
    }
    if (entry.trimmed) {
      // トリム済みエントリはolderCursorを失っている。差分を続けるとolderページング不能が
      // キャッシュ破棄まで続くため、オープン時に全文で取り直してエントリを置き換える。
      diag("session_messages_cache_trimmed_refresh", { sessionId });
      return fetchFullAndStore(sessionId, directoryRaw, "trimmed_refresh");
    }
    try {
      return await fetchDeltaAndMerge(sessionId, directoryRaw, entry);
    } catch (error) {
      const code = errorCode(error);
      if (DISCARD_ERROR_CODES.has(code)) {
        await discardEntry(sessionId, code);
      }
      diag("session_messages_cache_delta_fallback", {
        sessionId,
        code,
        message: errorMessage(error),
      });
      // 409・ネットワークエラー・連鎖上限超過はすべて全文取得へ。ここで失敗したら
      // そのままthrowし、呼び出し元の既存エラー処理(パネルのエラー表示等)に任せる。
      return fetchFullAndStore(sessionId, directoryRaw, `delta_failed_${code || "unknown"}`);
    }
  }

  return { fetchRunnerSessionMessagesCached, flushPendingWrites };
}

export function useSessionMessagesCacheController(options: {
  fetchSessionMessages: FetchRunnerSessionMessagesFn;
  onSessionDiagLog?: SessionDiagLogFn;
}): SessionMessagesCacheController {
  const fetchRef = useRef(options.fetchSessionMessages);
  fetchRef.current = options.fetchSessionMessages;
  const diagRef = useRef(options.onSessionDiagLog);
  diagRef.current = options.onSessionDiagLog;
  const controllerRef = useRef<SessionMessagesCacheController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSessionMessagesCacheController({
      fetchSessionMessages: (sessionIdRaw, directoryRaw, fetchOptions) =>
        fetchRef.current(sessionIdRaw, directoryRaw, fetchOptions),
      onSessionDiagLog: (event, payload) => diagRef.current?.(event, payload),
    });
  }
  return controllerRef.current;
}
