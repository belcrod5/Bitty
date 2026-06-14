import { stripYouTubeTags } from "./youtube";

export type LlmUiStatus =
  | "idle"
  | "connecting"
  | "model_processing"
  | "tool_waiting_approval"
  | "tool_running"
  | "model_generating"
  | "completed"
  | "error";

export type SlashCommandName = "/status" | "/compact" | "/cancel-queue" | "/queue-cancel";

export function trimForInline(raw: string, max = 14): string {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function toInlineSummary(raw: unknown, max = 64): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return trimForInline(raw, max);
  try {
    return trimForInline(JSON.stringify(raw), max);
  } catch {
    return trimForInline(String(raw), max);
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeName = String((error as { name?: unknown }).name || "").toLowerCase();
  return maybeName === "aborterror";
}

export function llmStatusLabel(status: LlmUiStatus): string {
  if (status === "idle") return "idle";
  if (status === "connecting") return "connecting";
  if (status === "model_processing") return "model_processing";
  if (status === "tool_waiting_approval") return "tool_waiting_approval";
  if (status === "tool_running") return "tool_running";
  if (status === "model_generating") return "model_generating";
  if (status === "completed") return "completed";
  return "error";
}

export function llmStatusVisual(status: LlmUiStatus): {
  icon: string;
  bg: string;
  border: string;
  text: string;
} {
  if (status === "connecting") {
    return { icon: "◌", bg: "#eff6ff", border: "#93c5fd", text: "#1d4ed8" };
  }
  if (status === "model_processing") {
    return { icon: "◔", bg: "#f8fafc", border: "#cbd5e1", text: "#334155" };
  }
  if (status === "tool_waiting_approval") {
    return { icon: "!", bg: "#fff7ed", border: "#fdba74", text: "#c2410c" };
  }
  if (status === "tool_running") {
    return { icon: "◆", bg: "#ecfdf5", border: "#86efac", text: "#166534" };
  }
  if (status === "model_generating") {
    return { icon: "✎", bg: "#eef2ff", border: "#a5b4fc", text: "#4338ca" };
  }
  if (status === "completed") {
    return { icon: "✓", bg: "#ecfdf5", border: "#86efac", text: "#166534" };
  }
  if (status === "error") {
    return { icon: "✕", bg: "#fef2f2", border: "#fca5a5", text: "#b91c1c" };
  }
  return { icon: "○", bg: "#f8fafc", border: "#d1d5db", text: "#475569" };
}

export function liveLlmStatusPrefix(status: LlmUiStatus): string {
  if (status === "idle") return "待機中";
  if (status === "completed") return "完了";
  if (status === "error") return "エラー";
  if (status === "tool_waiting_approval") return "承認待ち";
  if (status === "tool_running") return "ツール実行中";
  if (status === "model_generating") return "返答生成中";
  if (status === "model_processing" || status === "connecting") return "思考中";
  return "処理中";
}

export function isLlmActiveStatus(status: LlmUiStatus): boolean {
  return (
    status === "connecting" ||
    status === "model_processing" ||
    status === "tool_waiting_approval" ||
    status === "tool_running" ||
    status === "model_generating"
  );
}

export function parseSlashCommandInput(rawInput: string): { name: SlashCommandName; raw: string } | null {
  const raw = String(rawInput || "").trim();
  if (!raw.startsWith("/")) return null;
  const command = raw.toLowerCase();
  const name = command.split(/\s+/, 1)[0] || "";
  if (name === "/status" || name === "/compact" || name === "/cancel-queue" || name === "/queue-cancel") {
    return { name: name as SlashCommandName, raw };
  }
  return null;
}

export function summarizeChatThinkingDetail(rawDetail: string): string {
  const detail = String(rawDetail || "").trim();
  if (!detail) return "";
  if (/toolrun:brave_search/i.test(detail)) return "Webを検索しています";
  if (/toolrun:youtube_search/i.test(detail)) return "YouTubeを検索しています";
  if (/toolrun:youtube_channel_latest/i.test(detail)) return "YouTubeの最新動画を確認しています";
  if (/toolrun:youtube_favorites/i.test(detail)) return "YouTubeのお気に入りを確認しています";
  if (/tool start:\s*file_open/i.test(detail)) return "ファイルを読んでいます";
  if (/tool start:\s*(file_write|file_edit)/i.test(detail)) return "ファイルを更新しています";
  if (/approval required/i.test(detail)) return "ツール実行の承認待ちです";
  if (/building response|delta:native/i.test(detail)) return "返答を組み立てています";
  const compact = trimForInline(detail, 90);
  return compact || "";
}

export function parseReplyDebugLines(rawDebug: string): string[] {
  const raw = String(rawDebug || "").trim();
  if (!raw) return [];
  const tailChars = raw.length > 4096 ? raw.slice(-4096) : raw;
  return tailChars
    .split("|")
    .slice(-96)
    .map((item) => trimForInline(item, 160))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function stripMarkdownForTts(raw: string): string {
  return String(raw || "")
    .replace(/[{\uFF5B]?\s*youtube\s*[:\uFF1A]\s*[A-Za-z0-9_-]{0,64}\s*[}\uFF5D]?/gi, " ")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\bhttps?\s*[:\uFF1A]\s*\/\/[^\s]+/gi, " ")
    .replace(/\bwww\.[^\s]+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|jp|io|co|dev|ai|app|gg|tv|info|biz|xyz|me|ly)(?:\/[^\s]*)?/gi, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]}]+/gi, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*(?:-{3,}|_{3,}|\*{3,})[ \t]*$/gm, "")
    .replace(/[`*_#~|[\]{}()<>]/g, " ")
    .replace(/\\/g, "");
}

export function sanitizeTextForTts(raw: string): string {
  const text = stripMarkdownForTts(stripYouTubeTags(raw))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text;
}
