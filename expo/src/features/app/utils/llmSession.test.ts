import { formatLlmSessionDisplayTitle, resolveLlmSessionDisplayTitle } from "./llmSession";

describe("formatLlmSessionDisplayTitle", () => {
  it("normalizes whitespace in a short title", () => {
    expect(formatLlmSessionDisplayTitle("  調査\n\t結果   を確認  ")).toBe("調査 結果 を確認");
  });

  it("bounds long Unicode titles without splitting surrogate pairs", () => {
    const title = formatLlmSessionDisplayTitle(`  調査  ${"🙂".repeat(10_000)}  完了  `);

    expect(Array.from(title)).toHaveLength(200);
    expect(title.startsWith("調査 🙂🙂")).toBe(true);
    expect(title.endsWith("🙂…")).toBe(true);
  });

  it("keeps a title at the limit unchanged", () => {
    const title = "界".repeat(200);

    expect(formatLlmSessionDisplayTitle(title)).toBe(title);
  });
});

describe("resolveLlmSessionDisplayTitle", () => {
  it("uses the same override, agent, message, and empty-title precedence", () => {
    const session = { agentDisplayName: "Agent title", firstUserMessage: "First message" };

    expect(resolveLlmSessionDisplayTitle(session, "Custom title")).toBe("Custom title");
    expect(resolveLlmSessionDisplayTitle(session)).toBe("Agent title");
    expect(resolveLlmSessionDisplayTitle({ firstUserMessage: "First message" })).toBe("First message");
    expect(resolveLlmSessionDisplayTitle({})).toBe("（ユーザーメッセージなし）");
  });
});
