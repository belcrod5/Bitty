export const RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS = 30_000;

export type RuntimeConversationFreshnessInput = {
  runtimeMessageCount: number;
  runtimeUpdatedAtMs: number;
  runtimeIsResponding: boolean;
  requestCompletedAtMs: number | null;
  restoredUpdatedAtMs: number | null;
  restoredMessageCount: number;
  nowMs: number;
};

export function shouldPreserveRuntimeConversationOnHydrate(
  input: RuntimeConversationFreshnessInput
): boolean {
  if (input.runtimeMessageCount <= 0) return false; // (a) ランタイム空 → 従来どおり置換
  if (input.runtimeIsResponding) return true; // (b) ライブターン進行中 → 保持
  const completedAtMs = input.requestCompletedAtMs || 0; // (c) このクライアントで完了直後 → 保持
  if (completedAtMs > 0 && input.nowMs - completedAtMs <= RUNTIME_CONVERSATION_FRESHNESS_GRACE_MS) {
    return true;
  }
  if (input.restoredUpdatedAtMs !== null && input.restoredUpdatedAtMs > 0) {
    return input.runtimeUpdatedAtMs >= input.restoredUpdatedAtMs; // (d) タイムスタンプ比較（同値は保持）
  }
  return input.runtimeMessageCount >= input.restoredMessageCount; // (e) 欠落時フォールバック
}
