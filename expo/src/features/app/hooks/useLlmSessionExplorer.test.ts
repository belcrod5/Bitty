import { buildLlmSessionHistoryEntry } from "./useLlmSessionExplorer";

describe("buildLlmSessionHistoryEntry", () => {
  it("uses the scoped directory identity while retaining the absolute cwd", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty",
    } as never, ".", new Map());

    expect(entry.directory).toBe(".");
    expect(entry.cwd).toBe("/workspace/bitty");
  });
});
