// ミニボード/Skiaボードのプレビューパネルが「割当セッションを再取得(hydrate)すべきか」を
// 判定する純ロジック。
//
// - 署名は割当ID(`panelId:sessionId:directory`)のみで作り、updatedAtは含めない。
//   updatedAtの変化は「パネルsnapshotが同一セッションを保持し、かつsnapshot側の既知
//   updatedAt以上ならスキップ」の条件付き再検証として扱う(1セッションのupdatedAt bumpで
//   全パネルが巻き添え再取得される問題の根治)。
// - ライブ応答中(isResponding)のセッションはrelay observerがruntimeを更新し続けるため
//   再取得しない。
// - snapshotはアンマウント後も共有ストア(AppRoot)に保持される前提で、再入場時は
//   snapshotの鮮度だけで差分再取得を決める。

export type PanelAssignmentCandidate = {
  sessionId: string;
  directory: string;
  updatedAt?: unknown;
};

export type PanelSnapshotForHydration = {
  selectedSessionId?: string;
  selectedSessionUpdatedAt?: string;
  isResponding?: boolean;
  isHydrating?: boolean;
  conversationMessages?: readonly unknown[];
} | null | undefined;

// 同一マウント内で発行済みのhydrate要求(進行中含む)の記録。
// 同じ割当+同じupdatedAtの再要求を抑止する。
export type PanelHydrationRequestMark = {
  assignmentSignature: string;
  updatedAtMs: number;
};

export type PanelHydrationDecision =
  | {
    action: "hydrate";
    reason: "assignment_changed" | "snapshot_lost" | "snapshot_stale" | "updated_at_advanced";
  }
  | {
    action: "skip";
    reason: "live_session" | "already_requested" | "snapshot_fresh";
  };

export function parsePanelUpdatedAtMs(value: unknown) {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function buildPanelAssignmentSignature(
  panelId: string,
  candidate: Pick<PanelAssignmentCandidate, "sessionId" | "directory"> | null | undefined
) {
  if (!candidate) return `${panelId}:`;
  return `${panelId}:${String(candidate.sessionId || "").trim()}:${String(candidate.directory || "").trim()}`;
}

export function buildPanelHydrationRequestMark(
  panelId: string,
  candidate: PanelAssignmentCandidate
): PanelHydrationRequestMark {
  return {
    assignmentSignature: buildPanelAssignmentSignature(panelId, candidate),
    updatedAtMs: parsePanelUpdatedAtMs(candidate.updatedAt),
  };
}

export function snapshotHoldsAssignedSession(
  snapshot: PanelSnapshotForHydration,
  sessionId: string
) {
  const snapshotSessionId = String(snapshot?.selectedSessionId || "").trim();
  return !!snapshotSessionId && snapshotSessionId === String(sessionId || "").trim();
}

export function decidePanelHydration(params: {
  panelId: string;
  candidate: PanelAssignmentCandidate;
  lastRequested?: PanelHydrationRequestMark | null;
  snapshot?: PanelSnapshotForHydration;
}): PanelHydrationDecision {
  const assignmentSignature = buildPanelAssignmentSignature(params.panelId, params.candidate);
  const candidateUpdatedAtMs = parsePanelUpdatedAtMs(params.candidate.updatedAt);
  const snapshot = params.snapshot || null;
  const holdsSession = snapshotHoldsAssignedSession(snapshot, params.candidate.sessionId);
  // ライブ応答中はrelay observer/runtime投影が最新を配信中。履歴の再取得はしない。
  if (holdsSession && snapshot?.isResponding) {
    return { action: "skip", reason: "live_session" };
  }
  // 同一マウント内で同じ割当+同じ(以下の)updatedAtを既に要求済みなら再要求しない。
  // 失敗後のホットリトライ抑止と、hydrate進行中の重複要求抑止を兼ねる。
  const lastRequested = params.lastRequested || null;
  const sameAssignmentRequested = lastRequested?.assignmentSignature === assignmentSignature;
  if (lastRequested && sameAssignmentRequested && candidateUpdatedAtMs <= lastRequested.updatedAtMs) {
    return { action: "skip", reason: "already_requested" };
  }
  if (!holdsSession) {
    // 要求済みなのにsnapshotが無い=クリア済み(失敗後など)。それ以外は割当変化。
    return {
      action: "hydrate",
      reason: sameAssignmentRequested ? "snapshot_lost" : "assignment_changed",
    };
  }
  const knownUpdatedAtMs = parsePanelUpdatedAtMs(snapshot?.selectedSessionUpdatedAt);
  const messageCount = Array.isArray(snapshot?.conversationMessages)
    ? snapshot.conversationMessages.length
    : 0;
  // hydrate完了済み(非hydrating・本文あり)かつ既知updatedAt以上 → 鮮度十分でスキップ。
  if (!snapshot?.isHydrating && messageCount > 0 && knownUpdatedAtMs > 0 && candidateUpdatedAtMs <= knownUpdatedAtMs) {
    return { action: "skip", reason: "snapshot_fresh" };
  }
  if (knownUpdatedAtMs > 0 && candidateUpdatedAtMs > knownUpdatedAtMs) {
    return { action: "hydrate", reason: "updated_at_advanced" };
  }
  return { action: "hydrate", reason: "snapshot_stale" };
}
