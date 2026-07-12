import type { ConversationMessage } from "../types/appTypes";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";

export function isCommandExecutionMessage(
  message: { commandExecution?: CodexCommandExecutionInfo } | null | undefined
): boolean {
  return !!message?.commandExecution;
}

export function findLatestAssistantMessageIndex(
  messages: readonly { role: string; commandExecution?: CodexCommandExecutionInfo }[]
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (isCommandExecutionMessage(message)) continue;
    return index;
  }
  return -1;
}

export function settleRunningCommandExecution(
  commandExecution: CodexCommandExecutionInfo,
  settledLlmStatus: string
): CodexCommandExecutionInfo {
  if (commandExecution.status !== "running") return commandExecution;
  return {
    ...commandExecution,
    status: settledLlmStatus === "error" ? "failed" : "completed",
  };
}

export function parseIsoTimestampMs(raw: unknown): number | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function summarizeExecutionReasonFromStatus(
  hasRunningTurn: boolean,
  hasPendingAssistant: boolean,
  restoredInFlight: boolean,
  runningTurnSummary: string,
  runningTurnStatus: string,
  latestToolLabel?: string,
): { reasonLabel: string; reasonDetail: string } {
  if (restoredInFlight) {
    return {
      reasonLabel: "実行中",
      reasonDetail: "復帰処理中",
    };
  }
  if (runningTurnSummary) {
    const detailParts = [
      latestToolLabel ? `実行中: ${latestToolLabel}` : "",
      runningTurnStatus ? `status=${runningTurnStatus}` : "",
    ].filter(Boolean);
    return {
      reasonLabel: runningTurnSummary,
      reasonDetail: detailParts.length > 0 ? detailParts.join(" / ") : runningTurnSummary,
    };
  }
  if (hasPendingAssistant) {
    return {
      reasonLabel: "応答待ち",
      reasonDetail: "assistant未到着",
    };
  }
  if (hasRunningTurn) {
    return {
      reasonLabel: "実行中",
      reasonDetail: runningTurnStatus ? `status=${runningTurnStatus}` : "turn継続中",
    };
  }
  return {
    reasonLabel: "実行中",
    reasonDetail: "",
  };
}

export function summarizeStalePendingAssistantReason() {
  return {
    reasonLabel: "状態不明",
    reasonDetail: "assistant未到着（長時間更新なし）",
  };
}

export function inferLatestToolLabelFromAssistantMessages(messages: ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role !== "assistant") continue;
    const content = String(item.content || "").trim();
    const toolMatch = content.match(/^tool\s*:\s*(.+)$/i);
    if (toolMatch) {
      const label = String(toolMatch[1] || "").trim().split(/\s+/)[0] || "";
      if (label) return label;
    }
    const toolCompactMatch = content.match(/^tool:([^\s]+)/i);
    if (toolCompactMatch) {
      const label = String(toolCompactMatch[1] || "").trim();
      if (label) return label;
    }
  }
  return "";
}

export function hasPendingAssistantReplyInConversation(messagesRaw: unknown) {
  const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i] as ConversationMessage;
    if (!item || typeof item !== "object") continue;
    if (isCommandExecutionMessage(item)) continue;
    return item.role === "user";
  }
  return false;
}
