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

test("legacy unscoped title is shared without assigning it to one backend", () => {
  const values = { [runnerSessionKey("legacy", "same")]: "Old title" };
  expect(runnerSessionValue(values, "codex", "same")).toBe("Old title");
  expect(runnerSessionValue(values, "claude", "same")).toBe("Old title");
  values[runnerSessionKey("codex", "same")] = "";
  expect(runnerSessionValue(values, "codex", "same")).toBe("");
});
