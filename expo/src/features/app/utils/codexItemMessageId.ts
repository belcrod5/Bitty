// Derives a conversation message id from a Codex app-server thread item id.
//
// 実測済みの制約 (codex-cli 0.144.5):
// - ライブ通知 (item/started, item/completed, deltas) の item.id は
//   raw Responses API id ("msg_…", reasoning は "rs_…")。
// - thread/read が返す item.id は読み出し時に合成されるスレッド内連番
//   ("item-N")。再読間では決定的だが、ライブ通知のidとは一致しない。
//
// つまりこのIDは「再ハイドレーションを跨いで不変」ではない。価値は:
// - ライブ配信の全経路 (useCodexReplyRequest / relay observer) が同一itemを
//   同一IDでupsertし、重複バブルやID発散を防ぐこと。
// - 復元側 (buildRestoredPanelConversation) のIDがハイドレーション間で
//   決定的になり、2回目以降のハイドレーションはID一致で照合できること。
// ライブ→復元のID断絶は panelHydrationFreshness の reconcile が
// TTSターゲット限定の正規化本文照合でリマップして吸収する。
export function codexItemMessageId(threadId: string, itemId: string) {
  return `codex-item-${threadId}-${itemId}`;
}
