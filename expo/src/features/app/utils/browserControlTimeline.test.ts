import { browserControlTimeline } from "./browserControlTimeline";
import type { BrowserControlRequest } from "../hooks/useBrowserControl";

const card = (requestId: string, createdAt: string): BrowserControlRequest => ({ requestId, createdAt, label: "Password",
  origin: "https://example.com", status: "pending",
  target: { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "native" }, cwd: "/repo" } });
test("presentation rows place cards chronologically and keep ordinary messages and indexes untouched", () => {
  const messages = [{ id: "before", role: "user", content: "one", at: "2026-11-26T00:00:00Z" },
    { id: "after", role: "assistant", content: "two", at: "2026-11-26T00:03:00Z" }];
  const snapshot = JSON.stringify(messages);
  const rows = browserControlTimeline(messages, [card("second", "2026-11-26T00:02:00Z"), card("first", "2026-11-26T00:01:00Z")]);
  expect(rows.map((row) => row.id)).toEqual(["before", "browser-control:first", "browser-control:second", "after"]);
  expect(rows[0]).toBe(messages[0]); expect(rows[3]).toBe(messages[1]);
  expect(JSON.stringify(messages)).toBe(snapshot);
  expect(browserControlTimeline(messages, [])).toBe(messages);
});
