// A stable text-only estimate for messages without model usage. CJK characters
// usually take more tokens per character than Latin text.
export function estimateMessageTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/gu) || [];
  const remaining = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/gu, "");
  return Math.max(1, cjk.length + Math.ceil(new TextEncoder().encode(remaining).length / 4));
}

export function formatMessageTokens(text: string, outputTokens?: number): string {
  const measured = typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
  const count = measured ? outputTokens : estimateMessageTokens(text);
  const units = ["", "k", "m", "b"];
  let scaled = count;
  let unit = 0;
  while (scaled >= 999.95 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  const compact = unit === 0 ? String(count)
    : `${scaled.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
  return `${measured ? "" : "~"}${compact} tok`;
}
