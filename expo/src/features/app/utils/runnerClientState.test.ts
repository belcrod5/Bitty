import { runnerSessionKey, runnerSessionValue } from "./runnerClientState";

test("custom session metadata is isolated by backend", () => {
  const values = {
    [runnerSessionKey("codex", "same")]: "Codex title",
    [runnerSessionKey("claude", "same")]: "Claude title",
  };
  expect(runnerSessionValue(values, "codex", "same")).toBe("Codex title");
  expect(runnerSessionValue(values, "claude", "same")).toBe("Claude title");
  expect(runnerSessionValue(values, "codex", "other")).toBeUndefined();
});

test("unscoped old titles are not reused by another backend", () => {
  const values = { [runnerSessionKey("legacy", "same")]: "Old title" };
  expect(runnerSessionValue(values, "codex", "same")).toBeUndefined();
  expect(runnerSessionValue(values, "claude", "same")).toBeUndefined();
});
