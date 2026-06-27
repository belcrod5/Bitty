import type { DirectorySessionTreeState, RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";
import { collectRegisteredDirectorySessions } from "./registeredDirectorySessions";

function session(overrides: Partial<LlmSessionHistoryEntry>): LlmSessionHistoryEntry {
  return {
    sessionId: "session",
    parentSessionId: "",
    directory: "",
    updatedAt: "2026-06-01T00:00:00.000Z",
    lastReadAt: "",
    source: "appserver",
    cwd: "",
    firstUserMessage: "title",
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "",
    reasoningEffort: "",
    ...overrides,
  };
}

function tree(entries: LlmSessionHistoryEntry[]): DirectorySessionTreeState {
  return {
    loading: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 0,
    error: "",
    latestSessionId: "",
    nextCursor: "",
    hasMore: false,
    entries,
    childrenByParentId: {},
  };
}

describe("collectRegisteredDirectorySessions", () => {
  const directories: RegisteredDirectoryEntry[] = [
    { id: "first", path: "/workspace/first", displayName: "First", markerColor: "gray" },
    { id: "second", path: "/workspace/second", displayName: "", markerColor: "red" },
  ];

  it("enriches, deduplicates, and sorts sessions from all registered directories", () => {
    const result = collectRegisteredDirectorySessions(directories, {
      first: tree([
        session({ sessionId: "shared", updatedAt: "2026-06-01T00:00:00.000Z" }),
        session({ sessionId: "first-only", updatedAt: "2026-06-02T00:00:00.000Z" }),
      ]),
      second: tree([
        session({
          sessionId: "shared",
          updatedAt: "2026-06-03T00:00:00.000Z",
          cwd: "/actual/cwd",
        }),
      ]),
    });

    expect(result.map((item) => item.sessionId)).toEqual(["shared", "first-only"]);
    expect(result[0]).toMatchObject({
      directory: "/workspace/second",
      cwd: "/actual/cwd",
      directoryDisplayName: "/workspace/second",
    });
    expect(result[1]).toMatchObject({
      directory: "/workspace/first",
      cwd: "/workspace/first",
      directoryDisplayName: "First",
    });
  });

  it("keeps the first occurrence when duplicate timestamps are equal", () => {
    const result = collectRegisteredDirectorySessions(directories, {
      first: tree([session({ sessionId: "shared", firstUserMessage: "first" })]),
      second: tree([session({ sessionId: "shared", firstUserMessage: "second" })]),
    });

    expect(result).toHaveLength(1);
    expect(result[0].firstUserMessage).toBe("first");
    expect(result[0].directory).toBe("/workspace/first");
  });

  it("treats invalid timestamps as zero when sorting and choosing duplicates", () => {
    const result = collectRegisteredDirectorySessions(directories, {
      first: tree([
        session({ sessionId: "invalid-only", updatedAt: "invalid" }),
        session({ sessionId: "shared", updatedAt: "invalid", firstUserMessage: "invalid" }),
        session({ sessionId: "invalid-shared", updatedAt: "invalid", firstUserMessage: "first" }),
      ]),
      second: tree([
        session({ sessionId: "valid-only", updatedAt: "2026-06-03T00:00:00.000Z" }),
        session({ sessionId: "shared", updatedAt: "2026-06-02T00:00:00.000Z", firstUserMessage: "valid" }),
        session({ sessionId: "invalid-shared", updatedAt: "also-invalid", firstUserMessage: "second" }),
      ]),
    });

    expect(result.map((item) => item.sessionId)).toEqual([
      "valid-only",
      "shared",
      "invalid-only",
      "invalid-shared",
    ]);
    expect(result.find((item) => item.sessionId === "shared")?.firstUserMessage).toBe("valid");
    expect(result.find((item) => item.sessionId === "invalid-shared")?.firstUserMessage).toBe("first");
  });

  it("ignores blank directories and session ids", () => {
    const directoriesWithBlank: RegisteredDirectoryEntry[] = [
      ...directories,
      { id: "blank", path: " ", displayName: "Blank", markerColor: "none" },
    ];
    const result = collectRegisteredDirectorySessions(directoriesWithBlank, {
      first: tree([session({ sessionId: " " })]),
      second: tree([session({ sessionId: "valid" })]),
      blank: tree([session({ sessionId: "hidden" })]),
    });

    expect(result.map((item) => item.sessionId)).toEqual(["valid"]);
  });
});
