import type { ConversationMessage } from "../types/appTypes";
import { findPreviousUserMessageIndex } from "./chatScroll";

const messages = (...roles: ConversationMessage["role"][]): ConversationMessage[] => roles.map((role, index) => ({
  id: `message-${index}`,
  role,
  content: `${role}-${index}`,
}));

describe("findPreviousUserMessageIndex", () => {
  it("returns the user message immediately before the first visible item", () => {
    expect(findPreviousUserMessageIndex(messages("user", "assistant", "user", "assistant"), 3)).toBe(2);
    expect(findPreviousUserMessageIndex(messages("user", "assistant"), 1)).toBe(0);
  });

  it("returns the nearest user message when multiple users are above", () => {
    expect(findPreviousUserMessageIndex(messages("user", "assistant", "user", "assistant", "assistant"), 5)).toBe(2);
  });

  it("returns no target when no user message is above", () => {
    expect(findPreviousUserMessageIndex(messages("assistant", "assistant", "user"), 2)).toBeNull();
  });

  it("returns no target near the beginning", () => {
    expect(findPreviousUserMessageIndex(messages("user", "assistant"), 0)).toBeNull();
    expect(findPreviousUserMessageIndex([], 0)).toBeNull();
  });
});
