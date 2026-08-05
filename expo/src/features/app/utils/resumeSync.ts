// フォアグラウンド復帰・WS再接続時の再同期(resume sync)の純粋ロジック。
// - ready遷移(接続generation変化)ごとに1回だけ再同期を発火する判定
// - 再同期対象(選択セッション+可視パネル群)の決定
// - 全セッション合算のグローバルレート制御(通信量削減 修正計画 §4②)
// フックから分離してユニットテスト可能にしている。

export const RESUME_SYNC_PER_SESSION_MIN_INTERVAL_MS = 5000;
export const RESUME_SYNC_GLOBAL_WINDOW_MS = 10_000;
export const RESUME_SYNC_GLOBAL_MAX_PER_WINDOW = 6;

export type ResyncRateLimiter = {
  canResync: (sessionId: string, nowMs?: number) => boolean;
  recordResync: (sessionId: string, nowMs?: number) => void;
};

// 再同期(履歴全文の再取得)の合算レート制御。
// - セッション単位: perSessionMinIntervalMs 以内の再発火を抑止(resync→relay再開→喪失ループ防止)
// - グローバル: globalWindowMs の窓で globalMaxPerWindow 回まで(複数パネル並行時の合算超過防止)
export function createResyncRateLimiter(options?: {
  perSessionMinIntervalMs?: number;
  globalWindowMs?: number;
  globalMaxPerWindow?: number;
}): ResyncRateLimiter {
  const perSessionMinIntervalMs = Math.max(0, Math.floor(
    options?.perSessionMinIntervalMs ?? RESUME_SYNC_PER_SESSION_MIN_INTERVAL_MS
  ));
  const globalWindowMs = Math.max(0, Math.floor(
    options?.globalWindowMs ?? RESUME_SYNC_GLOBAL_WINDOW_MS
  ));
  const globalMaxPerWindow = Math.max(1, Math.floor(
    options?.globalMaxPerWindow ?? RESUME_SYNC_GLOBAL_MAX_PER_WINDOW
  ));
  const lastResyncAtBySessionId = new Map<string, number>();
  let recentResyncAts: number[] = [];
  const pruneRecent = (nowMs: number) => {
    recentResyncAts = recentResyncAts.filter((at) => nowMs - at < globalWindowMs);
  };
  return {
    canResync: (sessionIdRaw: string, nowMs: number = Date.now()) => {
      const sessionId = String(sessionIdRaw || "").trim();
      if (!sessionId) return false;
      const lastAt = lastResyncAtBySessionId.get(sessionId);
      if (lastAt !== undefined && nowMs - lastAt < perSessionMinIntervalMs) return false;
      pruneRecent(nowMs);
      return recentResyncAts.length < globalMaxPerWindow;
    },
    recordResync: (sessionIdRaw: string, nowMs: number = Date.now()) => {
      const sessionId = String(sessionIdRaw || "").trim();
      if (!sessionId) return;
      lastResyncAtBySessionId.set(sessionId, nowMs);
      pruneRecent(nowMs);
      recentResyncAts.push(nowMs);
    },
  };
}

// runner WS の ready遷移1回につき再同期1回に coalesce するための判定。
export function shouldHandleReadyTransition(input: {
  connectionState: string;
  generation: number;
  lastHandledGeneration: number;
}): boolean {
  return (
    input.connectionState === "ready" &&
    Number.isFinite(input.generation) &&
    input.generation !== input.lastHandledGeneration
  );
}

export type ResumeSyncPanelEntry = {
  panelId: string;
  sessionId: string;
  directory: string;
  isResponding: boolean;
};

export type ResumeSyncTarget =
  | { kind: "selected"; sessionId: string }
  | { kind: "panel"; sessionId: string; panelId: string; directory: string };

export type ResumeSyncSkip = {
  sessionId: string;
  panelId?: string;
  reason:
    | "live_observer"
    | "session_already_covered"
    | "missing_directory";
};

export type ResumeSyncPlan = {
  targets: ResumeSyncTarget[];
  skipped: ResumeSyncSkip[];
};

// 再同期対象の決定。
// - 選択セッション(メインチャット)は常に対象。ただしライブrelay observerが同一
//   セッションで生存している場合は対象外(observer自身のseq resumeが第一経路で、
//   ここで全文再取得するとライブ配信路を壊す)。
// - パネルは「ポップアップ表示中」「応答中」「バックグラウンド移行時点で応答中だった」
//   もののみ対象(全パネルfan-outの再発防止)。
// - 同一セッションは1回だけ再同期する(選択セッション優先)。
export function planResumeSyncTargets(input: {
  selectedSessionId: string;
  observerThreadId: string;
  popupPanelId: string;
  panelEntries: ResumeSyncPanelEntry[];
  respondingSessionIds: string[];
}): ResumeSyncPlan {
  const targets: ResumeSyncTarget[] = [];
  const skipped: ResumeSyncSkip[] = [];
  const coveredSessionIds = new Set<string>();
  const selectedSessionId = String(input.selectedSessionId || "").trim();
  const observerThreadId = String(input.observerThreadId || "").trim();
  const popupPanelId = String(input.popupPanelId || "").trim();
  const respondingSessionIds = new Set(
    (Array.isArray(input.respondingSessionIds) ? input.respondingSessionIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );

  if (selectedSessionId) {
    if (observerThreadId && observerThreadId === selectedSessionId) {
      skipped.push({ sessionId: selectedSessionId, reason: "live_observer" });
    } else {
      targets.push({ kind: "selected", sessionId: selectedSessionId });
    }
    coveredSessionIds.add(selectedSessionId);
  }

  for (const entryRaw of Array.isArray(input.panelEntries) ? input.panelEntries : []) {
    const panelId = String(entryRaw?.panelId || "").trim();
    const sessionId = String(entryRaw?.sessionId || "").trim();
    if (!panelId || !sessionId) continue;
    const isPopupPanel = Boolean(popupPanelId) && panelId === popupPanelId;
    const wanted = (
      isPopupPanel ||
      entryRaw.isResponding === true ||
      respondingSessionIds.has(sessionId)
    );
    if (!wanted) continue;
    if (coveredSessionIds.has(sessionId)) {
      skipped.push({ sessionId, panelId, reason: "session_already_covered" });
      continue;
    }
    if (observerThreadId && sessionId === observerThreadId) {
      skipped.push({ sessionId, panelId, reason: "live_observer" });
      coveredSessionIds.add(sessionId);
      continue;
    }
    const directory = String(entryRaw.directory || "").trim();
    if (!directory) {
      skipped.push({ sessionId, panelId, reason: "missing_directory" });
      continue;
    }
    targets.push({ kind: "panel", sessionId, panelId, directory });
    coveredSessionIds.add(sessionId);
  }

  return { targets, skipped };
}
