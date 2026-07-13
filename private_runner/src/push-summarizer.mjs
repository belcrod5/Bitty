const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FALLBACK_MAX_CHARS = 120;

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildSummaryPrompt(text) {
  return [
    "以下はAIアシスタントがタスクを完了した際の応答です。",
    "スマートフォンのPUSH通知本文として使える、日本語1〜2文の短い要約だけを出力してください。前置きや記号は不要です。",
    "---",
    text,
  ].join("\n");
}

// Summarizes a turn-completed reply into a short push-notification body.
// `runCodex` is injected by the caller (server-runtime.mjs) so this module never
// imports the large server-runtime file directly (avoids a circular import).
// Never throws and never blocks longer than `timeoutMs`: on any failure it falls
// back to a truncated copy of the source text so a notification is still sent.
export function createPushSummarizer({
  runCodex,
  modelInfo,
  reasoningEffort = "low",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fallbackMaxChars = DEFAULT_FALLBACK_MAX_CHARS,
} = {}) {
  async function summarize(textRaw) {
    const source = String(textRaw || "").trim();
    if (!source) return "";
    const fallback = truncate(source, fallbackMaxChars);
    if (typeof runCodex !== "function") return fallback;

    const controller = new AbortController();
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        runCodex(buildSummaryPrompt(source), {
          modelInfo,
          reasoningEffort,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      const trimmed = String(result || "").trim();
      return trimmed || fallback;
    } catch {
      return fallback;
    }
  }

  return { summarize };
}
