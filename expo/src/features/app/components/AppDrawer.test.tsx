import React from "react";
import { fireEvent, render, userEvent } from "@testing-library/react-native";
import { AppDrawer, type AppDrawerProps, type DirectorySessionTreeState } from "./AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";

const mockAddSession = jest.fn();
const mockRemoveSession = jest.fn();
const mockHasSession = jest.fn(() => false);
jest.mock("../contexts/SkiaBoardContext", () => ({
  useSkiaBoard: () => ({
    addSession: mockAddSession,
    removeSession: mockRemoveSession,
    hasSession: mockHasSession,
    loaded: true,
  }),
}));

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
  refreshing: false,
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
    highlightedSessionId: "",
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
    directoryReadProgressByPath: {},
    directoryUnreadCountByPath: {},
    directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
    sessionTitleOverridesById: {
      "loaded-restore": "Restore title override",
    },
    sessionMarkerColorsById: {},
    llmSessionRestoreLoading: false,
    llmSessionRestoreTargetId: "",
    formatSessionUpdatedAt: () => "today",
    onOpenDebug: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockHasSession.mockReturnValue(false);
});

test("opens the board from the left navigation", async () => {
  const onOpenSkiaBoard = jest.fn();
  const drawer = await renderDrawer({ onOpenSkiaBoard });

  await fireEvent.press(drawer.getByText("Board"));

  expect(onOpenSkiaBoard).toHaveBeenCalledTimes(1);
});

test("adds a long-pressed session to the Skia board", async () => {
  const drawer = await renderDrawer();
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Fix drawer search"));
  await fireEvent.press(drawer.getByText("Skiaボードへ追加"));

  expect(mockAddSession).toHaveBeenCalledWith("loaded-search");
});

test("shows progress for a directory read operation", async () => {
  const drawer = await renderDrawer({
    directoryReadProgressByPath: {
      "/work/bitty": { completed: 1, total: 4 },
    },
  });

  expect(drawer.getByText("既読にしています 1/4")).toBeTruthy();
});

test("shows the authoritative 66 unread total when 55 sessions are outside the loaded rows", async () => {
  const registeredDirectories = [
    ["downloads", "/downloads", "Downloads", 10, 0],
    ["gogcli", "/gogcli", "gogcli", 2, 2],
    ["pta", "/pta", "pta", 1, 1],
    ["test", "/test_folder", "test_folder", 42, 0],
    ["collabo", "/collabo_link", "collabo_link", 4, 3],
    ["relief", "/relief-box2", "relief-box2", 7, 5],
  ] as const;
  const directoryUnreadCountByPath = Object.fromEntries(
    registeredDirectories.map(([, path, , unreadCount]) => [path, unreadCount])
  );
  const loadedUnreadCount = registeredDirectories.reduce((sum, entry) => sum + entry[4], 0);

  const drawer = await renderDrawer({
    expandedDirectoryIds: [],
    registeredDirectories: registeredDirectories.map(([id, path, displayName]) => ({
      id,
      path,
      displayName,
      markerColor: "none",
    })),
    directoryUnreadCountByPath,
    directorySessionsById: Object.fromEntries(registeredDirectories.map(([id, path, , , visibleUnread]) => [
      id,
      directoryState(Array.from({ length: 5 }, (_, index) => session({
        sessionId: `${id}-${index}`,
        directory: path,
        cwd: path,
        updatedAt: index < visibleUnread ? "2026-06-18T00:00:00.000Z" : "2026-06-17T00:00:00.000Z",
      }))),
    ])),
  });

  expect(Object.values(directoryUnreadCountByPath).reduce((sum, count) => sum + count, 0)).toBe(66);
  expect(66 - loadedUnreadCount).toBe(55);
  expect(drawer.getByLabelText("Downloadsの未読 10件")).toBeTruthy();
  expect(drawer.getByLabelText("test_folderの未読 42件")).toBeTruthy();
  expect(drawer.getByLabelText("relief-box2の未読 7件")).toBeTruthy();
});

test("shows one aggregate progress bar for registered directory session sync", async () => {
  const drawer = await renderDrawer({
    directorySessionSync: {
      ...IDLE_DIRECTORY_SESSION_SYNC,
      cycleId: 1,
      phase: "loading",
      totalCount: 4,
      pendingCount: 2,
      completedCount: 2,
      progress: 0.5,
    },
  });

  expect(drawer.getByText("セッション同期中 2/4")).toBeTruthy();
  expect(
    drawer.getByLabelText("登録ディレクトリのセッション同期").props.accessibilityValue
  ).toEqual({
    min: 0,
    max: 4,
    now: 2,
    text: "2/4",
  });
});

test("shows a terminal partial error instead of leaving sync pending", async () => {
  const drawer = await renderDrawer({
    directorySessionSync: {
      ...IDLE_DIRECTORY_SESSION_SYNC,
      cycleId: 1,
      phase: "partial_error",
      totalCount: 3,
      failedCount: 1,
      completedCount: 3,
      progress: 1,
    },
  });

  expect(drawer.getByRole("alert").props.children).toBe("一部更新失敗 1/3");
  expect(drawer.queryByLabelText("登録ディレクトリのセッション同期")).toBeNull();
});

test("runs the directory read action from the long-press menu", async () => {
  const onMarkDirectorySessionsRead = jest.fn();
  const drawer = await renderDrawer({ onMarkDirectorySessionsRead });
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Bitty"));
  await user.press(drawer.getByText("このディレクトリの未読をすべて既読にする"));

  expect(onMarkDirectorySessionsRead).toHaveBeenCalledWith("/work/bitty");
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
