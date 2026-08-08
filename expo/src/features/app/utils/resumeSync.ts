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
  // canResyncがfalseのとき、許可されるまでの待ち時間(ms)。既に許可済みなら0。
  // 呼び出し側はこれを使って「取りこぼし禁止の再同期」をone-shot遅延リトライにできる。
  msUntilAllowed: (sessionId: string, nowMs?: number) => number;
  // このセッション自身のクールダウン(perSessionMinIntervalMs)中かどうか。
  // 「セッション単位の抑止(=ループガード)」と「グローバル枠超過(=他セッションの
  // 混雑)」を区別したい呼び出し側(relay-loss回復の遅延再試行など)が使う。
  isSessionCoolingDown: (sessionId: string, nowMs?: number) => boolean;
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
    isSessionCoolingDown: (sessionIdRaw: string, nowMs: number = Date.now()) => {
      const sessionId = String(sessionIdRaw || "").trim();
      if (!sessionId) return false;
      const lastAt = lastResyncAtBySessionId.get(sessionId);
      return lastAt !== undefined && nowMs - lastAt < perSessionMinIntervalMs;
    },
    msUntilAllowed: (sessionIdRaw: string, nowMs: number = Date.now()) => {
      const sessionId = String(sessionIdRaw || "").trim();
      if (!sessionId) return Number.POSITIVE_INFINITY;
      const lastAt = lastResyncAtBySessionId.get(sessionId);
      const perSessionWaitMs = lastAt !== undefined
        ? Math.max(0, perSessionMinIntervalMs - (nowMs - lastAt))
        : 0;
      pruneRecent(nowMs);
      let globalWaitMs = 0;
      if (recentResyncAts.length >= globalMaxPerWindow) {
        // 窓内件数が globalMaxPerWindow-1 まで減るのは、古い方から
        // (len - max + 1) 件が期限切れになった時点。その最後の1件の期限を待つ。
        const releaseAt = recentResyncAts[recentResyncAts.length - globalMaxPerWindow] + globalWindowMs;
        globalWaitMs = Math.max(0, releaseAt - nowMs);
      }
      return Math.max(perSessionWaitMs, globalWaitMs);
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

// 1セッション=1ターゲット。同一セッションを表示する全可視パネルをまとめて持ち、
// レート制御は1回の獲得で全反映先に適用する(relay-loss回復経路と同じ扱い)。
export type ResumeSyncSessionTarget = {
  sessionId: string;
  selected: boolean;
  panels: Array<{ panelId: string; directory: string }>;
};

export type ResumeSyncSkip = {
  sessionId: string;
  panelId?: string;
  reason:
    | "live_observer"
    | "turn_in_flight"
    | "missing_directory";
};

export type ResumeSyncPlan = {
  targets: ResumeSyncSessionTarget[];
  skipped: ResumeSyncSkip[];
};

// 再同期対象の決定。
// - 選択セッション(メインチャット)は常に対象。ただしライブrelay observerが同一
//   セッションで生存している場合は対象外(observer自身のseq resumeが第一経路で、
//   ここで全文再取得するとライブ配信路を壊す)。
// - パネルは「ポップアップ表示中」「応答中」「バックグラウンド移行時点で応答中だった」
//   もののみ対象(全パネルfan-outの再発防止)。
// - このクライアントのreply request(turn.ts)がin-flightなセッションのパネルは対象外
//   (turnInFlightSessionIds)。選択セッションのreplyLoadingスキップと同じ理屈で、
//   turn.ts自身のws_reconnect_resume(seq resume)がライブ復旧を担うため、ここで
//   全文再取得するとストリーミング表示を上書きしてしまう。呼び出し側はこのスキップで
//   respondingマーカー(G2)を消費しないので、turn完了後の回収経路は保たれる。
// - 同一セッションを表示する可視パネルは全て同じターゲットにまとめ、レート制御1回で
//   全パネルへ反映する(#40 relay-loss回復経路と同じ扱い)。
export function planResumeSyncTargets(input: {
  selectedSessionId: string;
  observerThreadId: string;
  popupPanelId: string;
  panelEntries: ResumeSyncPanelEntry[];
  respondingSessionIds: string[];
  turnInFlightSessionIds?: string[];
}): ResumeSyncPlan {
  const skipped: ResumeSyncSkip[] = [];
  const targetsBySessionId = new Map<string, ResumeSyncSessionTarget>();
  const selectedSessionId = String(input.selectedSessionId || "").trim();
  const observerThreadId = String(input.observerThreadId || "").trim();
  const popupPanelId = String(input.popupPanelId || "").trim();
  const respondingSessionIds = new Set(
    (Array.isArray(input.respondingSessionIds) ? input.respondingSessionIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const turnInFlightSessionIds = new Set(
    (Array.isArray(input.turnInFlightSessionIds) ? input.turnInFlightSessionIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const ensureTarget = (sessionId: string): ResumeSyncSessionTarget => {
    const existing = targetsBySessionId.get(sessionId);
    if (existing) return existing;
    const created: ResumeSyncSessionTarget = { sessionId, selected: false, panels: [] };
    targetsBySessionId.set(sessionId, created);
    return created;
  };

  if (selectedSessionId) {
    if (observerThreadId && observerThreadId === selectedSessionId) {
      skipped.push({ sessionId: selectedSessionId, reason: "live_observer" });
    } else {
      ensureTarget(selectedSessionId).selected = true;
    }
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
    if (observerThreadId && sessionId === observerThreadId) {
      skipped.push({ sessionId, panelId, reason: "live_observer" });
      continue;
    }
    if (turnInFlightSessionIds.has(sessionId)) {
      skipped.push({ sessionId, panelId, reason: "turn_in_flight" });
      continue;
    }
    const directory = String(entryRaw.directory || "").trim();
    if (!directory) {
      skipped.push({ sessionId, panelId, reason: "missing_directory" });
      continue;
    }
    ensureTarget(sessionId).panels.push({ panelId, directory });
  }

  return {
    targets: Array.from(targetsBySessionId.values()),
    skipped,
  };
}
