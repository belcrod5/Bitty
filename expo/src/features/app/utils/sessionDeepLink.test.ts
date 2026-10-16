import { parseSessionDeepLink, parseVoiceDeepLink } from "./sessionDeepLink";

it("parses a bounded Bitty session message link", () => {
  expect(parseSessionDeepLink(
    "bitty://session/claude/session-1?messageId=msg_1&cwd=%2Fwork%2Fproject"
  )).toEqual({
    backendId: "claude",
    sessionId: "session-1",
    messageId: "msg_1",
    cwd: "/work/project",
  });
});

it("resolves a Siri voice link to its orchestrator id", () => {
  expect(parseVoiceDeepLink("bitty://voice/main")).toBe("main");
  expect(parseVoiceDeepLink("bitty://voice/8e7c-1234")).toBe("8e7c-1234");
});

it.each([
  "bitty://voice/",
  "bitty://voice/main/other",
  "bitty://voice/main?selected=other",
  "bitty://voice/main#other",
  "https://example.com/voice/main",
  "bitty://voice/%2Fprivate",
])("rejects an invalid Siri voice link: %s", (url) => {
  expect(parseVoiceDeepLink(url)).toBeNull();
});

it.each([
  "https://example.com/session/codex/session-1?messageId=msg_1&cwd=/work",
  "bitty://session/codex/session-1?messageId=msg_1",
  "bitty://session/codex/session-1?messageId=../secret&cwd=/work",
  "bitty://session/codex/session-1?messageId=msg_1&cwd=relative",
  `bitty://session/codex/session-1?messageId=msg_1&cwd=/${"x".repeat(2050)}`,
])("rejects an invalid or incomplete session link: %s", (url) => {
  expect(parseSessionDeepLink(url)).toBeNull();
});
