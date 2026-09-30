import { estimateMessageTokens, formatMessageTokens } from "./messageTokens";

describe("message tokens", () => {
  it("estimates Unicode text without requiring a tokenizer", () => {
    expect(estimateMessageTokens("hello world")).toBe(3);
    expect(estimateMessageTokens("こんにちは世界")).toBe(7);
    expect(estimateMessageTokens("😀")).toBe(1);
    expect(formatMessageTokens("こんにちは世界")).toBe("~7 tok");
  });

  it("uses measured output tokens and formats compact boundaries", () => {
    expect(formatMessageTokens("long reply", 0)).toBe("0 tok");
    expect(formatMessageTokens("long reply", 999)).toBe("999 tok");
    expect(formatMessageTokens("long reply", 1_000)).toBe("1k tok");
    expect(formatMessageTokens("long reply", 1_500)).toBe("1.5k tok");
    expect(formatMessageTokens("long reply", 999_949)).toBe("999.9k tok");
    expect(formatMessageTokens("long reply", 999_950)).toBe("1m tok");
    expect(formatMessageTokens("long reply", 999_999)).toBe("1m tok");
    expect(formatMessageTokens("long reply", 1_000_000)).toBe("1m tok");
  });
});
