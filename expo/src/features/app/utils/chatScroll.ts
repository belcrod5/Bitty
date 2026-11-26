export function findPreviousUserMessageIndex(
  messages: readonly { role?: "user" | "assistant" }[],
  firstVisibleIndex: number
) {
  const startIndex = Math.min(Math.max(0, Math.floor(firstVisibleIndex)) - 1, messages.length - 1);
  for (let index = startIndex; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return null;
}
