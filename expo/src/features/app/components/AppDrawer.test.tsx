import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { AppDrawer, type AppDrawerProps, type DirectorySessionTreeState } from "./AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";

function session(overrides: Partial<LlmSessionHistoryEntry>): LlmSessionHistoryEntry {
  return {
    sessionId: "session-default",
    parentSessionId: "",
    directory: "/work/bitty",
    updatedAt: "2026-06-17T00:00:00.000Z",
    lastReadAt: "2026-06-17T00:00:00.000Z",
    source: "cli",
    cwd: "/work/bitty",
    firstUserMessage: "Default loaded session",
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "gpt-5.5",
    reasoningEffort: "high",
    ...overrides,
  };
}

function directoryState(
  entries: LlmSessionHistoryEntry[],
  childrenByParentId: DirectorySessionTreeState["childrenByParentId"] = {},
): DirectorySessionTreeState {
  return {
    loading: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: entries[0]?.sessionId || "",
    nextCursor: "next-page",
    hasMore: true,
    entries,
    childrenByParentId,
  };
}

function renderDrawer(overrides: Partial<AppDrawerProps> = {}) {
  const loadedSessions = [
    session({
      sessionId: "loaded-search",
      firstUserMessage: "Fix drawer search",
    }),
    session({
      sessionId: "loaded-restore",
      firstUserMessage: "Restore title fallback",
    }),
  ];
  const props: AppDrawerProps = {
    selectedDirectoryPath: "/work/bitty",
    selectedLlmSessionId: "",
    registeredDirectories: [{
      id: "dir-1",
      path: "/work/bitty",
      displayName: "Bitty",
      markerColor: "none",
    }],
    expandedDirectoryIds: ["dir-1"],
    directorySessionsById: {
      "dir-1": directoryState(loadedSessions),
    },
    sessionTitleOverridesById: {
      "loaded-restore": "Restore title override",
    },
    sessionMarkerColorsById: {},
    llmSessionRestoreLoading: false,
    llmSessionRestoreTargetId: "",
    formatSessionUpdatedAt: () => "today",
    onOpenDebug: jest.fn(),
    onOpenMiniBoard: jest.fn(),
    onOpenCloudflareTunnelMonitor: jest.fn(),
    onOpenSkiaBoard: jest.fn(),
    onOpenDirectoryExplorer: jest.fn(),
    onToggleDirectoryExpanded: jest.fn(),
    onLoadMoreSessions: jest.fn(),
    onLoadSessionChildren: jest.fn(),
    onStartNewSessionInDirectory: jest.fn(),
    onSelectSessionHistoryEntry: jest.fn(),
    onMarkSessionRead: jest.fn(),
    onMarkSessionUnread: jest.fn(),
    onMarkDirectorySessionsRead: jest.fn(),
    ...overrides,
  };
  return render(<AppDrawer {...props} />);
}

test("opens Skia Board from the left navigation", async () => {
  const onOpenSkiaBoard = jest.fn();
  const drawer = await renderDrawer({ onOpenSkiaBoard });

  expect(drawer.getByText("Mini Board")).toBeTruthy();
  await fireEvent.press(drawer.getByText("Skia Board"));

  expect(onOpenSkiaBoard).toHaveBeenCalledTimes(1);
});

test("filters only loaded drawer sessions", async () => {
  const drawer = await renderDrawer();

  expect(drawer.getByText("Fix drawer search")).toBeTruthy();
  expect(drawer.getByText("Restore title override")).toBeTruthy();

  const searchInput = drawer.getByPlaceholderText("ディレクトリ・履歴を検索");
  await fireEvent.changeText(searchInput, "restore title");

  expect(drawer.queryByText("Fix drawer search")).toBeNull();
  expect(drawer.getByText("Restore title override")).toBeTruthy();

  await fireEvent.changeText(searchInput, "unloaded deploy note");

  expect(drawer.queryByText("Fix drawer search")).toBeNull();
  expect(drawer.queryByText("Restore title override")).toBeNull();
  expect(drawer.getByText("一致するディレクトリまたは履歴はありません。")).toBeTruthy();
});

test("clears drawer search back to the loaded session list", async () => {
  const drawer = await renderDrawer();

  const searchInput = drawer.getByPlaceholderText("ディレクトリ・履歴を検索");
  await fireEvent.changeText(searchInput, "restore title");
  await fireEvent.press(drawer.getByLabelText("検索をクリア"));

  expect(drawer.getByText("Fix drawer search")).toBeTruthy();
  expect(drawer.getByText("Restore title override")).toBeTruthy();
});

test("refreshes and expands loaded subagent children in the drawer", async () => {
  const parent = session({
    sessionId: "parent-session",
    firstUserMessage: "Parent task",
  });
  const child = session({
    sessionId: "child-session",
    parentSessionId: "parent-session",
    source: "subagent",
    firstUserMessage: "Child agent task",
  });
  const onLoadSessionChildren = jest.fn();
  const drawer = await renderDrawer({
    directorySessionsById: {
      "dir-1": directoryState([parent], {
        "parent-session": {
          loading: false,
          loaded: true,
          error: "",
          entries: [child],
        },
      }),
    },
    onLoadSessionChildren,
  });

  await fireEvent.press(drawer.getByLabelText("サブエージェントを開く"));

  expect(drawer.getByText("Child agent task")).toBeTruthy();
  expect(onLoadSessionChildren).toHaveBeenCalledWith("dir-1", "/work/bitty", "parent-session");
});

test("does not show or load grandchildren until their parent is expanded", async () => {
  const parent = session({ sessionId: "parent-session", firstUserMessage: "Parent task" });
  const child = session({
    sessionId: "child-session",
    parentSessionId: "parent-session",
    source: "subagent",
    firstUserMessage: "Child agent task",
  });
  const grandchild = session({
    sessionId: "grandchild-session",
    parentSessionId: "child-session",
    source: "subagent",
    firstUserMessage: "Grandchild agent task",
  });
  const onLoadSessionChildren = jest.fn();
  const drawer = await renderDrawer({
    directorySessionsById: {
      "dir-1": directoryState([parent], {
        "parent-session": { loading: false, loaded: true, error: "", entries: [child] },
        "child-session": { loading: false, loaded: true, error: "", entries: [grandchild] },
      }),
    },
    onLoadSessionChildren,
  });

  await fireEvent.press(drawer.getByLabelText("サブエージェントを開く"));

  expect(drawer.getByText("Child agent task")).toBeTruthy();
  expect(drawer.queryByText("Grandchild agent task")).toBeNull();
  expect(onLoadSessionChildren).not.toHaveBeenCalledWith("dir-1", "/work/bitty", "child-session");

  await fireEvent.press(drawer.getByLabelText("サブエージェントを開く"));

  expect(drawer.getByText("Grandchild agent task")).toBeTruthy();
  expect(onLoadSessionChildren).toHaveBeenCalledWith("dir-1", "/work/bitty", "child-session");
});

test("loads subagent children when an unloaded drawer session is expanded", async () => {
  const onLoadSessionChildren = jest.fn();
  const drawer = await renderDrawer({
    directorySessionsById: {
      "dir-1": directoryState([
        session({
          sessionId: "parent-session",
          firstUserMessage: "Parent task",
        }),
      ]),
    },
    onLoadSessionChildren,
  });

  await fireEvent.press(drawer.getByLabelText("サブエージェントを開く"));

  expect(onLoadSessionChildren).toHaveBeenCalledWith("dir-1", "/work/bitty", "parent-session");
});
