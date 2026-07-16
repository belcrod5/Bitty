// Codex app-server assigns every thread item a per-thread unique id ("item-42")
// that is identical in live turn events (item/started, item/completed, deltas)
// and in later thread/read restores. Deriving conversation message ids from it
// keeps a message's id stable across panel rehydration, so TTS playback targets
// and per-message metadata survive without content matching.
//
// Live minting (useCodexReplyRequest) and restore minting (AppRoot panel
// hydration via buildRestoredPanelConversation) must both use this function.
export function codexItemMessageId(threadId: string, itemId: string) {
  return `codex-item-${threadId}-${itemId}`;
}
