import { useCallback, type Dispatch, type MutableRefObject } from "react";
import type { ConversationMessage } from "../types/appTypes";

type SetConversationMessagesOptions = {
  resetVisibleCount?: boolean;
  visibleCount?: number;
  totalCountOverride?: number;
};

type UseConversationMessageWindowControllerArgs = {
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  setConversationMessages: Dispatch<ConversationMessage[]>;
};

export function useConversationMessageWindowController({
  conversationMessagesRef,
  setConversationMessages,
}: UseConversationMessageWindowControllerArgs) {
  const setConversationMessagesWithLimit = useCallback((
    nextMessages: ConversationMessage[],
    _opts?: SetConversationMessagesOptions
  ) => {
    const allMessages = Array.isArray(nextMessages) ? nextMessages : [];
    conversationMessagesRef.current = allMessages;
    setConversationMessages(allMessages);
    return allMessages;
  }, [
    conversationMessagesRef,
    setConversationMessages,
  ]);

  const removeConversationMessageById = useCallback((messageId: string) => {
    const id = String(messageId || "").trim();
    if (!id) return;
    const current = conversationMessagesRef.current;
    const index = current.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = [...current.slice(0, index), ...current.slice(index + 1)];
    setConversationMessagesWithLimit(next);
  }, [conversationMessagesRef, setConversationMessagesWithLimit]);

  const patchConversationMessageById = useCallback((
    messageId: string,
    patch: Omit<Partial<ConversationMessage>, "id" | "role" | "content">
  ) => {
    const id = String(messageId || "").trim();
    if (!id) return;
    const current = conversationMessagesRef.current;
    const index = current.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = [...current];
    next[index] = {
      ...next[index],
      ...patch,
    };
    setConversationMessagesWithLimit(next);
  }, [conversationMessagesRef, setConversationMessagesWithLimit]);

  return {
    setConversationMessagesWithLimit,
    removeConversationMessageById,
    patchConversationMessageById,
  };
}
