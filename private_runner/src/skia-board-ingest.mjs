// Skiaボードの自動カード追加(ingest)。書き手をランナー1箇所に集約し、
// 複数デバイスの二重追加・位置衝突を構造的に無くす(設計書 Step 4)。
//
// - 主トリガ: ターン完了通知(relay / スケジュール実行 / agent run の3経路が収束する
//   turnCompletionNotifier の broadcast コールバック)
// - 補完トリガ: GET /skia-board 時のスイープ(ランナーを経由せずホスト上のCLIから
//   直接作られたセッションを拾う。ファイル監視は導入しない)
// - 対象は ingestDirectories(各端末の登録ディレクトリの和集合)のみ

export function createSkiaBoardIngest({
  boardService,
  listAgentSessionsForDirectories,
  resolveDirectory,
  now = () => new Date(),
  minSweepIntervalMs = 30_000,
} = {}) {
  let lastSweepAtMs = 0;
  let sweepInFlight = null;

  async function collectCandidates(directories) {
    const groups = await listAgentSessionsForDirectories(directories, { includeSubagents: false });
    const candidates = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const session of group.sessionsById.values()) {
        candidates.push({
          sessionId: session.sessionId,
          backendId: session.backendId,
          directory: session.directory,
          updatedAt: session.updatedAt,
        });
      }
    }
    // 新しい順に並べる(空ボード初期化時に先頭6件を採用する既存ロジックに合わせる)。
    candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return candidates;
  }

  async function ingestDirectoriesNow(directories) {
    if (!Array.isArray(directories) || directories.length <= 0) return null;
    const candidates = await collectCandidates(directories);
    if (candidates.length <= 0) return null;
    return boardService.ingestSessions(candidates);
  }

  // 補完スイープ。セッション一覧のフルスキャンを伴うため最小間隔でスロットルし、
  // 多重呼び出しは実行中の1本に合流させる。
  function sweep({ force = false } = {}) {
    if (sweepInFlight) return sweepInFlight;
    const nowMs = now().getTime();
    if (!force && nowMs - lastSweepAtMs < minSweepIntervalMs) return Promise.resolve(null);
    lastSweepAtMs = nowMs;
    sweepInFlight = (async () => {
      try {
        const directories = await boardService.getIngestDirectories();
        return await ingestDirectoriesNow(directories);
      } catch (error) {
        console.warn("[skia-board] ingest sweep failed", error);
        return null;
      } finally {
        sweepInFlight = null;
      }
    })();
    return sweepInFlight;
  }

  // ターン完了。該当ディレクトリがingest対象なら、そのディレクトリだけ取り込み直す。
  // 単発candidateではなく一覧の引き直しにすることで、updatedAtの正確さと
  // 同ディレクトリの取りこぼし補完(自己修復)を両立する。
  async function onTurnCompleted(payload) {
    try {
      const rawDirectory = String(payload?.directory || "").trim();
      if (!rawDirectory) return null;
      const directory = String(await resolveDirectory(rawDirectory) || "").trim();
      if (!directory) return null;
      const registered = await boardService.getIngestDirectories();
      if (!registered.includes(directory)) return null;
      return await ingestDirectoriesNow([directory]);
    } catch (error) {
      console.warn("[skia-board] turn-completed ingest failed", error);
      return null;
    }
  }

  return { sweep, onTurnCompleted };
}
