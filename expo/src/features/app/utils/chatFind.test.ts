import type { ConversationMessage } from "../types/appTypes";
import { findChatMessageMatches } from "./chatFind";

const messages: ConversationMessage[] = [
  { id: "first", role: "user", content: "Alpha alpha alphabet" },
  { id: "internal", role: "assistant", kind: "internal_context", content: "collapsed ALPHA" },
  { id: "empty", role: "assistant", content: "" },
];

describe("findChatMessageMatches", () => {
  it("finds every case-insensitive occurrence in stored message content", () => {
    expect(findChatMessageMatches(messages, "alpha")).toEqual([
      { messageId: "first", messageIndex: 0, offset: 0 },
      { messageId: "first", messageIndex: 0, offset: 6 },
      { messageId: "first", messageIndex: 0, offset: 12 },
      { messageId: "internal", messageIndex: 1, offset: 10 },
    ]);
  });

  it("does not match an empty query", () => {
    expect(findChatMessageMatches(messages, "")).toEqual([]);
  });
});
