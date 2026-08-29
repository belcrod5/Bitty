import { parseSessionDeepLink } from "./sessionDeepLink";

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

it.each([
  "https://example.com/session/codex/session-1?messageId=msg_1&cwd=/work",
  "bitty://session/codex/session-1?messageId=msg_1",
  "bitty://session/codex/session-1?messageId=../secret&cwd=/work",
  "bitty://session/codex/session-1?messageId=msg_1&cwd=relative",
  `bitty://session/codex/session-1?messageId=msg_1&cwd=/${"x".repeat(2050)}`,
])("rejects an invalid or incomplete session link: %s", (url) => {
  expect(parseSessionDeepLink(url)).toBeNull();
});
