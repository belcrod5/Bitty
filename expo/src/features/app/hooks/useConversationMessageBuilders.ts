import { useCallback, type MutableRefObject } from "react";
import type { ConversationMessage, HistoryEntry, SttMessageMeta } from "../types/appTypes";

type UseConversationMessageBuildersArgs = {
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  autoPendingUserMessageIdRef: MutableRefObject<string>;
  resolveAutoPendingUserMessage: (content: string, sttMeta?: SttMessageMeta) => boolean;
  buildConversationMessage: (
    role: "user" | "assistant",
    content: string,
    extra?: Omit<Partial<ConversationMessage>, "id" | "role" | "content">
  ) => ConversationMessage;
  playAssistantEventSfx: (contentRaw: string) => void;
  setConversationMessagesWithLimit: (
    nextMessages: ConversationMessage[],
    opts?: {
      resetVisibleCount?: boolean;
      visibleCount?: number;
      totalCountOverride?: number;
    }
  ) => ConversationMessage[];
};

export function appendAssistantEventMessageToMessages(params: {
  messages: ConversationMessage[];
  line: string;
  buildConversationMessage: (
    role: "user" | "assistant",
    content: string,
    extra?: Omit<Partial<ConversationMessage>, "id" | "role" | "content">
  ) => ConversationMessage;
}) {
  const content = String(params.line || "").trim();
  if (!content) return null;
  const prev = Array.isArray(params.messages) ? params.messages : [];
  const last = prev[prev.length - 1];
  if (
    last &&
    last.role === "assistant" &&
    String(last.content || "").trim() === content
  ) {
    return null;
  }
  return [
    ...prev,
    params.buildConversationMessage("assistant", content),
  ];
}

export function useConversationMessageBuilders({
  conversationMessagesRef,
  autoPendingUserMessageIdRef,
  resolveAutoPendingUserMessage,
  buildConversationMessage,
  playAssistantEventSfx,
  setConversationMessagesWithLimit,
}: UseConversationMessageBuildersArgs) {
  const createHistoryEntry = useCallback((params: { transcript: string; reply: string }): HistoryEntry => {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toLocaleTimeString(),
      transcript: params.transcript,
      reply: params.reply,
    };
  }, []);

  const appendAssistantEventMessage = useCallback((line: string) => {
    const content = String(line || "").trim();
    if (!content) return;
    const next = appendAssistantEventMessageToMessages({
      messages: conversationMessagesRef.current,
      line: content,
      buildConversationMessage,
    });
    if (!next) return;
    playAssistantEventSfx(content);
    setConversationMessagesWithLimit(next);
  }, [
    buildConversationMessage,
    conversationMessagesRef,
    playAssistantEventSfx,
    setConversationMessagesWithLimit,
  ]);

  const buildConversationWithLatestUserMessage = useCallback((transcriptText: string, sttMeta?: SttMessageMeta) => {
    const normalized = String(transcriptText || "").trim();
    if (!normalized) return conversationMessagesRef.current;
    const pendingId = autoPendingUserMessageIdRef.current;
    if (pendingId) {
      const pendingResolved = resolveAutoPendingUserMessage(normalized, sttMeta);
      if (pendingResolved) {
        return conversationMessagesRef.current;
      }
    }
    return [
      ...conversationMessagesRef.current,
      buildConversationMessage("user", normalized, sttMeta ? { sttMeta } : {}),
    ];
  }, [
    autoPendingUserMessageIdRef,
    buildConversationMessage,
    conversationMessagesRef,
    resolveAutoPendingUserMessage,
  ]);

  return {
    createHistoryEntry,
    appendAssistantEventMessage,
    buildConversationWithLatestUserMessage,
  };
}
