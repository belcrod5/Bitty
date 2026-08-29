import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ChatSessionSubagentList } from "./ChatSessionSubagentList";
import type { DirectorySessionTreeState } from "./AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";

function session(overrides: Partial<LlmSessionHistoryEntry>): LlmSessionHistoryEntry {
  return {
    backendId: "codex",
    sessionId: "session-default",
    parentSessionId: "",
    directory: "/work/bitty",
    updatedAt: "2026-06-21T00:00:00.000Z",
    lastReadAt: "",
    source: "cli",
    cwd: "/work/bitty",
    firstUserMessage: "Default session",
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "",
    reasoningEffort: "",
    ...overrides,
  };
}

test("shows and opens the direct parent of the selected subagent", async () => {
  const parent = session({ sessionId: "parent", firstUserMessage: "Parent task" });
  const child = session({
    sessionId: "child",
    parentSessionId: "parent",
    source: "subagent",
    agentDisplayName: "Child agent",
    directory: "/work/bitty/child-worktree",
    cwd: "/work/bitty/child-worktree",
  });
  const directoryState: DirectorySessionTreeState = {
        loading: false,
        refreshing: false,
        loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: "parent",
    nextCursor: "",
    hasMore: false,
    entries: [parent],
    childrenByParentId: {
      parent: { loading: false, loaded: true, error: "", entries: [child] },
      child: { loading: false, loaded: true, error: "", entries: [] },
    },
  };
  const openSessionHistoryEntry = jest.fn();
  const onCloseMenu = jest.fn();
  const view = await render(
    <ChatSessionSubagentList
      selectedSessionId="child"
      selectedDirectoryPath="/work/bitty/child-worktree"
      registeredDirectories={[{
        id: "dir-1",
        path: "/work/bitty",
        displayName: "Bitty",
        markerColor: "none",
      }]}
      directorySessionsById={{ "dir-1": directoryState }}
      sessionTitleOverridesById={{}}
      formatSessionUpdatedAt={() => "today"}
      loadSessionChildren={jest.fn(async () => undefined)}
      openSessionHistoryEntry={openSessionHistoryEntry}
      onCloseMenu={onCloseMenu}
    />
  );

  expect(view.getByText("Parent agent")).toBeTruthy();
  await fireEvent.press(view.getByText("Parent task"));

  expect(onCloseMenu).toHaveBeenCalledTimes(1);
  expect(openSessionHistoryEntry).toHaveBeenCalledWith({
    backendId: "codex",
    sessionId: "parent",
    source: "cli",
    directory: "/work/bitty",
  });
});

test("resolves children by the selected directory when the session is outside the cached window", async () => {
  // 選択中セッションがドロワーの取得ウィンドウ外(entriesに無い)でも、
  // 選択中ディレクトリのパスからchildrenByParentIdを直接解決できること。
  const child = session({
    sessionId: "child",
    parentSessionId: "out-of-window-parent",
    source: "subagent",
    firstUserMessage: "Windowed child task",
  });
  const directoryState: DirectorySessionTreeState = {
    loading: false,
    refreshing: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: "recent",
    nextCursor: "cursor-1",
    hasMore: true,
    entries: [session({ sessionId: "recent" })],
    childrenByParentId: {
      "out-of-window-parent": { loading: false, loaded: true, error: "", entries: [child] },
    },
  };
  const view = await render(
    <ChatSessionSubagentList
      selectedSessionId="out-of-window-parent"
      selectedDirectoryPath="/work/bitty"
      registeredDirectories={[{
        id: "dir-1",
        path: "/work/bitty",
        displayName: "Bitty",
        markerColor: "none",
      }]}
      directorySessionsById={{ "dir-1": directoryState }}
      sessionTitleOverridesById={{}}
      formatSessionUpdatedAt={() => "now"}
      loadSessionChildren={jest.fn(async () => undefined)}
      openSessionHistoryEntry={jest.fn()}
      onCloseMenu={jest.fn()}
    />
  );

  expect(view.getByText("Windowed child task")).toBeTruthy();
});

test("loads children for an uncached session through the selected directory", async () => {
  const directoryState: DirectorySessionTreeState = {
    loading: false,
    refreshing: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: "recent",
    nextCursor: "",
    hasMore: false,
    entries: [session({ sessionId: "recent" })],
    childrenByParentId: {},
  };
  const loadSessionChildren = jest.fn(async () => undefined);
  await render(
    <ChatSessionSubagentList
      selectedSessionId="out-of-window-parent"
      selectedDirectoryPath="/work/bitty"
      registeredDirectories={[{
        id: "dir-1",
        path: "/work/bitty",
        displayName: "Bitty",
        markerColor: "none",
      }]}
      directorySessionsById={{ "dir-1": directoryState }}
      sessionTitleOverridesById={{}}
      formatSessionUpdatedAt={() => "now"}
      loadSessionChildren={loadSessionChildren}
      openSessionHistoryEntry={jest.fn()}
      onCloseMenu={jest.fn()}
    />
  );

  expect(loadSessionChildren).toHaveBeenCalledWith("out-of-window-parent", "/work/bitty");
});

test("opens a child with the child's own working directory", async () => {
  const child = session({
    sessionId: "child",
    parentSessionId: "parent",
    source: "subagent",
    directory: "/work/bitty/child-worktree",
    cwd: "/work/bitty/child-worktree",
    firstUserMessage: "Child task",
  });
  const openSessionHistoryEntry = jest.fn();
  const directoryState: DirectorySessionTreeState = {
        loading: false,
        refreshing: false,
        loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: "parent",
    nextCursor: "",
    hasMore: false,
    entries: [session({ sessionId: "parent" })],
    childrenByParentId: {
      parent: { loading: false, loaded: true, error: "", entries: [child] },
    },
  };
  const tree = await render(
    <ChatSessionSubagentList
      selectedSessionId="parent"
      selectedDirectoryPath="/work/bitty"
      registeredDirectories={[{
        id: "dir-1",
        path: "/work/bitty",
        displayName: "Bitty",
        markerColor: "none",
      }]}
      directorySessionsById={{ "dir-1": directoryState }}
      sessionTitleOverridesById={{}}
      formatSessionUpdatedAt={() => "now"}
      loadSessionChildren={jest.fn()}
      openSessionHistoryEntry={openSessionHistoryEntry}
      onCloseMenu={jest.fn()}
    />
  );

  fireEvent.press(tree.getByText("Child task"));

  expect(openSessionHistoryEntry).toHaveBeenCalledWith({
    backendId: "codex",
    sessionId: "child",
    source: "subagent",
    directory: "/work/bitty/child-worktree",
  });
});
