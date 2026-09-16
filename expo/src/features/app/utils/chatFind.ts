import type { ConversationMessage } from "../types/appTypes";

export type ChatFindMatch = {
  messageId: string;
  messageIndex: number;
  offset: number;
};

export function findChatMessageMatches(
  messages: readonly ConversationMessage[],
  query: string
): ChatFindMatch[] {
  if (!query) return [];

  const needle = query.toLowerCase();
  const matches: ChatFindMatch[] = [];
  messages.forEach((message, messageIndex) => {
    const content = String(message.content || "").toLowerCase();
    let offset = content.indexOf(needle);
    while (offset >= 0) {
      matches.push({ messageId: message.id, messageIndex, offset });
      offset = content.indexOf(needle, offset + needle.length);
    }
  });
  return matches;
}
