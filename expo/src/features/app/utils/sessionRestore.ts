import type {
  ConversationMessage,
  HistoryEntry,
  LlmSessionMessage,
  LlmSessionMessageRole,
} from "../types/appTypes";
import type { RunnerSessionMessagesResult } from "../hooks/useLlmSessionExplorer";
import { parseLlmSessionMessageRole } from "./llmSession";
import { normalizeModelRef, parseModelRef, parseReasoningEffort, type ReasoningEffort } from "./settingsParsers";

type ModelOptionLike = {
  value: string;
  label: string;
};

type BuildConversationMessageLike = (
  role: LlmSessionMessageRole,
  content: string,
  opts?: {
    at?: string;
  }
) => ConversationMessage;

type BuildRestoredSessionStateArgs = {
  restored: RunnerSessionMessagesResult;
  buildConversationMessage: BuildConversationMessageLike;
  modelOptions: readonly ModelOptionLike[];
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  prevEffectiveSessionId: string;
  nextSessionId: string;
};

type AdoptRestoredSessionDirectoryArgs = {
  directory: string;
  resolvedSessionId: string;
  nextSessionId: string;
  llmSessionDirectoryRef: { current: string };
  setReplyDebug: (updater: (prev: string) => string) => void;
  rememberKnownCodexThreadId: (threadIdRaw: unknown) => void;
};

export type RestoredSessionState = {
  restoredMessages: LlmSessionMessage[];
  nextConversation: ConversationMessage[];
  nextHistory: HistoryEntry[];
  effectiveContextUsedPct: number | null;
  nextModelRef: string;
  nextReasoningEffort: ReasoningEffort;
  modelChanged: boolean;
  thinkChanged: boolean;
  sessionSwitchToastText: string;
};

function isCompactSlashAssistantMessage(message: ConversationMessage) {
  if (message.role !== "assistant") return false;
  const detail = String(message.llmStatusDetail || "").trim();
  return detail === "slash command running: /compact" || detail === "slash command: /compact";
}

function isCompactSlashUserMessage(message: ConversationMessage | undefined) {
  return message?.role === "user" && String(message.content || "").trim() === "/compact";
}

function conversationMessageKey(message: ConversationMessage) {
  return [
    message.role,
    String(message.content || "").trim(),
    String(message.llmStatusDetail || "").trim(),
  ].join("\u0000");
}

function conversationMessageTimestampMs(message: ConversationMessage) {
  const at = String(message.at || "").trim();
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function mergeLocalCompactSlashMessages(
  restoredConversation: ConversationMessage[],
  localConversation: ConversationMessage[]
) {
  const localCompactMessages: ConversationMessage[] = [];
  const localCompactKeys = new Set<string>();
  const addLocalCompactMessage = (message: ConversationMessage | undefined) => {
    if (!message) return;
    const key = conversationMessageKey(message);
    if (localCompactKeys.has(key)) return;
    localCompactKeys.add(key);
    localCompactMessages.push(message);
  };
  for (let index = 0; index < localConversation.length; index += 1) {
    const message = localConversation[index];
    if (!isCompactSlashAssistantMessage(message)) continue;
    const previousMessage = localConversation[index - 1];
    if (isCompactSlashUserMessage(previousMessage)) {
      addLocalCompactMessage(previousMessage);
    }
    addLocalCompactMessage(message);
  }
  if (localCompactMessages.length <= 0) return restoredConversation;

  const restoredKeys = new Set(restoredConversation.map(conversationMessageKey));
  const merged = [
    ...restoredConversation,
    ...localCompactMessages.filter((message) => !restoredKeys.has(conversationMessageKey(message))),
  ];
  return merged
    .map((message, index) => ({
      message,
      index,
      atMs: conversationMessageTimestampMs(message),
    }))
    .sort((left, right) => {
      if (left.atMs !== null && right.atMs !== null && left.atMs !== right.atMs) {
        return left.atMs - right.atMs;
      }
      return left.index - right.index;
    })
    .map((item) => item.message);
}

function clampContextUsedPct(raw: unknown): number | null {
  if (!Number.isFinite(Number(raw))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(raw))));
}

function toRestoredSessionMessages(restored: RunnerSessionMessagesResult): LlmSessionMessage[] {
  return restored.messages
    .map((item) => {
      const role = parseLlmSessionMessageRole(item.role);
      const content = String(item.content || "").trim();
      const at = String(item.at || "").trim();
      if (!role || !content) return null;
      return { role, content, at };
    })
    .filter((item): item is LlmSessionMessage => !!item);
}

export function buildRestoredSessionState({
  restored,
  buildConversationMessage,
  modelOptions,
  modelRef,
  reasoningEffort,
  prevEffectiveSessionId,
  nextSessionId,
}: BuildRestoredSessionStateArgs): RestoredSessionState {
  const restoredMessages = toRestoredSessionMessages(restored);
  const nextConversation = restoredMessages.map((item) => (
    buildConversationMessage(item.role, item.content, {
      at: item.at,
    })
  ));
  const nextHistory = buildHistoryFromSessionMessages(restoredMessages);
  const effectiveContextUsedPct = clampContextUsedPct(restored.contextUsedPct);
  const nextModelRef = restored.modelRef
    ? parseModelRef(restored.modelRef, modelOptions, modelRef)
    : modelRef;
  const nextReasoningEffort = restored.reasoningEffort
    ? parseReasoningEffort(restored.reasoningEffort, reasoningEffort)
    : reasoningEffort;
  const modelChanged = nextModelRef !== modelRef;
  const thinkChanged = nextReasoningEffort !== reasoningEffort;
  let sessionSwitchToastText = "";
  if (prevEffectiveSessionId && prevEffectiveSessionId !== nextSessionId && (modelChanged || thinkChanged)) {
    sessionSwitchToastText = (
      `${modelLabelForToast(modelRef, modelOptions)} ${reasoningEffort} → ` +
      `${modelLabelForToast(nextModelRef, modelOptions)} ${nextReasoningEffort}`
    );
  }
  return {
    restoredMessages,
    nextConversation,
    nextHistory,
    effectiveContextUsedPct,
    nextModelRef,
    nextReasoningEffort,
    modelChanged,
    thinkChanged,
    sessionSwitchToastText,
  };
}

export function adoptRestoredSessionDirectory({
  directory,
  resolvedSessionId,
  nextSessionId,
  llmSessionDirectoryRef,
  setReplyDebug,
  rememberKnownCodexThreadId,
}: AdoptRestoredSessionDirectoryArgs) {
  llmSessionDirectoryRef.current = directory;
  setReplyDebug((prev) => (
    prev
      ? `${prev} | session_restore_directory_adopted directory=${directory} session=${resolvedSessionId}`
      : `session_restore_directory_adopted directory=${directory} session=${resolvedSessionId}`
  ));
  rememberKnownCodexThreadId(nextSessionId);
  rememberKnownCodexThreadId(resolvedSessionId);
}

export function buildHistoryFromSessionMessages(messages: LlmSessionMessage[]) {
  const nextHistoryChronological: HistoryEntry[] = [];
  let latestUserText = "";
  for (const message of messages) {
    if (message.role === "user") {
      latestUserText = String(message.content || "").trim();
      continue;
    }
    if (message.role !== "assistant") continue;
    const createdDate = new Date(String(message.at || "").trim());
    nextHistoryChronological.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Number.isFinite(createdDate.getTime())
        ? createdDate.toLocaleTimeString()
        : new Date().toLocaleTimeString(),
      transcript: latestUserText,
      reply: String(message.content || "").trim(),
    });
    latestUserText = "";
  }
  return nextHistoryChronological.reverse();
}

export function modelLabelForToast(modelRefRaw: unknown, modelOptions: readonly ModelOptionLike[]) {
  const normalized = normalizeModelRef(modelRefRaw);
  if (!normalized) return "(default)";
  const matched = modelOptions.find((item) => item.value === normalized);
  return matched?.label || normalized;
}
