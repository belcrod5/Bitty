import { browserInputTimeline } from "./browserInputTimeline";
import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";

const card = (requestId: string, createdAt: string): BrowserSecretInputRequest => ({ requestId, createdAt, label: "Password",
  destinationOrigin: "https://example.com", topOrigin: "https://example.com", status: "pending",
  target: { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "native" }, cwd: "/repo" } });
test("presentation rows place cards chronologically and keep ordinary messages and indexes untouched", () => {
  const messages = [{ id: "before", role: "user", content: "one", at: "2026-11-26T00:00:00Z" },
    { id: "after", role: "assistant", content: "two", at: "2026-11-26T00:03:00Z" }];
  const snapshot = JSON.stringify(messages);
  const rows = browserInputTimeline(messages, [card("second", "2026-11-26T00:02:00Z"), card("first", "2026-11-26T00:01:00Z")]);
  expect(rows.map((row) => row.id)).toEqual(["before", "browser-input:first", "browser-input:second", "after"]);
  expect(rows[0]).toBe(messages[0]); expect(rows[3]).toBe(messages[1]);
  expect(JSON.stringify(messages)).toBe(snapshot);
  expect(browserInputTimeline(messages, [])).toBe(messages);
});
