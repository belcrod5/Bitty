import React from "react";
import { act, fireEvent, render, userEvent, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { AppDrawer, type AppDrawerProps, type DirectorySessionTreeState } from "./AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";

const mockAddSession = jest.fn();
const mockRemoveSession = jest.fn();
const mockHasSession = jest.fn(() => false);
const mockAddDirectory = jest.fn();
const mockRemoveDirectory = jest.fn();
const mockHasDirectory = jest.fn(() => false);
let mockSkiaBoardLoaded = true;
let mockRunnerUrl = "http://runner";
let mockRunnerToken = "runner-token";
jest.mock("../contexts/SkiaBoardContext", () => ({
  useSkiaBoard: () => ({
    addDirectory: mockAddDirectory,
    removeDirectory: mockRemoveDirectory,
    hasDirectory: mockHasDirectory,
    addSession: mockAddSession,
    removeSession: mockRemoveSession,
    hasSession: mockHasSession,
    loaded: mockSkiaBoardLoaded,
  }),
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({ runnerUrl: mockRunnerUrl, runnerToken: mockRunnerToken }),
}));

function session(overrides: Partial<LlmSessionHistoryEntry>): LlmSessionHistoryEntry {
  return {
    backendId: "codex",
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

function conversationSearchResult(snippet: string, messageId: string) {
  return {
    sessionRef: { backendId: "codex", nativeSessionId: `session-${messageId}` },
    canonicalCwd: "/work/bitty",
    sessionCreatedAt: "2026-08-30T00:00:00.000Z",
    messageId,
    role: "assistant",
    snippet,
    conversationCursor: `read-${messageId}`,
  };
}

function workspacesResponse(directories: string[] = ["/work/bitty"]): Response {
  return {
    ok: true,
    json: async () => ({
      workspaces: directories.map((canonicalRoot) => ({ canonicalRoot })),
    }),
  } as Response;
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
    onOpenSettings: jest.fn(),
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
  mockHasDirectory.mockReturnValue(false);
  mockSkiaBoardLoaded = true;
  mockRunnerUrl = "http://runner";
  mockRunnerToken = "runner-token";
});

test("starts a new chat in the pressed drawer directory", async () => {
  const onStartNewSessionInDirectory = jest.fn();
  const drawer = await renderDrawer({ onStartNewSessionInDirectory });

  await fireEvent.press(drawer.getByText("Bitty"));

  expect(onStartNewSessionInDirectory).toHaveBeenCalledWith("/work/bitty");
});

test("opens the board from the left navigation", async () => {
  const onOpenSkiaBoard = jest.fn();
  const drawer = await renderDrawer({ onOpenSkiaBoard });

  await fireEvent.press(drawer.getByText("Board"));

  expect(onOpenSkiaBoard).toHaveBeenCalledTimes(1);
});

test("opens Settings from the left navigation", async () => {
  const onOpenSettings = jest.fn();
  const drawer = await renderDrawer({ onOpenSettings });

  await fireEvent.press(drawer.getByText("設定"));

  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(drawer.getByText("接続・モデル・音声を設定")).toBeTruthy();
});

test("adds a long-pressed session to the Skia board", async () => {
  const drawer = await renderDrawer();
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Fix drawer search"));
  await fireEvent.press(drawer.getByText("Skiaボードへ追加"));

  expect(mockAddSession).toHaveBeenCalledWith("loaded-search");
});

test("keeps the Skia board action available while persisted board state is unavailable", async () => {
  mockSkiaBoardLoaded = false;
  const drawer = await renderDrawer();
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Fix drawer search"));

  expect(drawer.getByText("Skiaボードへ追加")).toBeTruthy();
  await fireEvent.press(drawer.getByTestId("app-drawer-skia-board-session-action"));
  expect(mockAddSession).not.toHaveBeenCalled();
});

test("adds and removes a long-pressed directory shortcut on the Skia board", async () => {
  const drawer = await renderDrawer();
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Bitty"));
  await fireEvent.press(drawer.getByTestId("app-drawer-skia-board-directory-action"));
  expect(mockAddDirectory).toHaveBeenCalledWith({
    directory: "/work/bitty",
    name: "Bitty",
  });

  mockHasDirectory.mockReturnValue(true);
  await user.longPress(drawer.getByText("Bitty"));
  expect(drawer.getByText("Skiaボードから除外")).toBeTruthy();
  await fireEvent.press(drawer.getByTestId("app-drawer-skia-board-directory-action"));
  expect(mockRemoveDirectory).toHaveBeenCalledWith("/work/bitty");
});

test("disables the directory board action until persisted state has loaded", async () => {
  mockSkiaBoardLoaded = false;
  const drawer = await renderDrawer();
  const user = userEvent.setup();

  await user.longPress(drawer.getByText("Bitty"));
  await fireEvent.press(drawer.getByTestId("app-drawer-skia-board-directory-action"));

  expect(mockAddDirectory).not.toHaveBeenCalled();
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

test("filters directories without filtering their loaded sessions", async () => {
  const drawer = await renderDrawer();

  expect(drawer.getByText("Fix drawer search")).toBeTruthy();
  expect(drawer.getByText("Restore title override")).toBeTruthy();

  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent.changeText(searchInput, "bitty");

  expect(drawer.getByText("Fix drawer search")).toBeTruthy();
  expect(drawer.getByText("Restore title override")).toBeTruthy();

  await fireEvent.changeText(searchInput, "restore title");

  expect(drawer.queryByText("Fix drawer search")).toBeNull();
  expect(drawer.queryByText("Restore title override")).toBeNull();
  expect(drawer.getByText("一致するディレクトリはありません。")).toBeTruthy();
});

test("clears drawer search back to the loaded session list", async () => {
  const drawer = await renderDrawer();

  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent.changeText(searchInput, "not-a-directory");
  await fireEvent.press(drawer.getByLabelText("検索をクリア"));

  expect(drawer.getByText("Fix drawer search")).toBeTruthy();
  expect(drawer.getByText("Restore title override")).toBeTruthy();
});

test("opens the floating search on focus and closes it explicitly", async () => {
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");

  expect(drawer.queryByTestId("app-drawer-search-popover")).toBeNull();
  await fireEvent(searchInput, "focus");
  expect(drawer.getByTestId("app-drawer-search-popover")).toBeTruthy();
  expect(drawer.getByRole("tab", { name: "ディレクトリ" })).toBeTruthy();
  expect(drawer.getByRole("tab", { name: "チャット" })).toBeTruthy();

  await fireEvent.press(drawer.getByLabelText("検索を閉じる"));
  await waitFor(() => expect(drawer.queryByTestId("app-drawer-search-popover")).toBeNull());
});

test("keeps the floating search open while switching modes inside it", async () => {
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent(searchInput, "blur");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));

  await waitFor(() => expect(drawer.getByTestId("app-drawer-search-popover")).toBeTruthy());
  expect(drawer.getByPlaceholderText("チャット内を検索")).toBeTruthy();
});

test("lets chat results use the remaining viewport without a fixed height cap", async () => {
  const drawer = await renderDrawer();
  await fireEvent(drawer.getByTestId("app-drawer-scroll"), "layout", {
    nativeEvent: { layout: { x: 0, y: 54, width: 360, height: 646 } },
  });
  await fireEvent(drawer.getByPlaceholderText("ディレクトリを検索"), "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  await fireEvent(drawer.getByTestId("app-drawer-search-container"), "layout", {
    nativeEvent: { layout: { x: 16, y: 12, width: 328, height: 42 } },
  });
  await fireEvent(drawer.getByTestId("app-drawer-search-popover"), "layout", {
    nativeEvent: { layout: { x: 0, y: 48, width: 328, height: 350 } },
  });

  await waitFor(() => expect(
    StyleSheet.flatten(drawer.getByTestId("app-drawer-search-popover").props.style).height
  ).toBe(628));
  const resultsStyle = StyleSheet.flatten(drawer.getByTestId("app-drawer-search-results").props.style);

  await fireEvent(drawer.getByTestId("app-drawer-scroll"), "layout", {
    nativeEvent: { layout: { x: 0, y: 54, width: 360, height: 446 } },
  });
  await waitFor(() => expect(
    StyleSheet.flatten(drawer.getByTestId("app-drawer-search-popover").props.style).height
  ).toBe(428));
  expect(StyleSheet.flatten(drawer.getByTestId("app-drawer-search-popover").props.style).maxHeight).toBeUndefined();
  expect(resultsStyle).toMatchObject({ flex: 1, minHeight: 0 });
  expect(resultsStyle.maxHeight).toBeUndefined();
});

test("waits for Enter before searching registered directories and opens the result", async () => {
  const onSelectSessionHistoryEntry = jest.fn();
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{
          sessionRef: { backendId: "codex", nativeSessionId: "found-session" },
          canonicalCwd: "/work/bitty",
          sessionCreatedAt: "2026-08-30T00:00:00.000Z",
          messageId: "message-1",
          role: "assistant",
          snippet: "Found the drawer conversation",
          conversationCursor: "read-cursor",
        }],
        scanned: { sessions: 1, items: 4, pages: 1 },
      }),
    } as Response);
  const drawer = await renderDrawer({ onSelectSessionHistoryEntry });
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "drawer conversation");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(drawer.getByText("検索キーで検索します。")).toBeTruthy();
  await fireEvent(chatInput, "submitEditing");

  await waitFor(() => expect(drawer.getByText("Found the drawer conversation")).toBeTruthy());
  expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/agent/workspaces");
  const url = new URL(String(fetchMock.mock.calls[1][0]));
  expect(url.searchParams.getAll("cwd")).toEqual(["/work/bitty"]);
  expect(url.searchParams.get("backendId")).toBe("all");

  await fireEvent.press(drawer.getByText("Found the drawer conversation"));
  expect(onSelectSessionHistoryEntry).toHaveBeenCalledWith(
    "codex",
    "found-session",
    "all",
    "/work/bitty",
    expect.objectContaining({ width: 68, height: 48 })
  );
  fetchMock.mockRestore();
});

test("does not restore debounced chat search while waiting for submit", async () => {
  jest.useFakeTimers();
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ results: [] }),
  } as Response);
  try {
    const drawer = await renderDrawer();
    const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
    await fireEvent(searchInput, "focus");
    await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
    await fireEvent.changeText(drawer.getByPlaceholderText("チャット内を検索"), "still waiting");

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(drawer.getByText("検索キーで検索します。")).toBeTruthy();
  } finally {
    fetchMock.mockRestore();
    jest.useRealTimers();
  }
});

test("invalidates an in-flight result when runner authentication changes", async () => {
  let resolveFirstRequest: ((response: Response) => void) | undefined;
  const firstRequest = new Promise<Response>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const fetchMock = jest.spyOn(global, "fetch")
    .mockImplementationOnce(() => firstRequest)
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("New runner result", "new-runner")] }),
    } as Response);
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "runner change");
  await fireEvent(chatInput, "submitEditing");
  expect(fetchMock).toHaveBeenCalledTimes(1);

  mockRunnerUrl = "http://new-runner";
  mockRunnerToken = "new-token";
  await fireEvent.press(drawer.getByText("検索オプション"));
  expect(drawer.getByText("検索キーで検索します。")).toBeTruthy();

  await act(async () => {
    resolveFirstRequest?.({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("Old runner result", "old-runner")] }),
    } as Response);
    await Promise.resolve();
  });
  expect(drawer.queryByText("Old runner result")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await fireEvent(chatInput, "submitEditing");
  await waitFor(() => expect(drawer.getByText("New runner result")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(String(fetchMock.mock.calls[1][0])).toContain("http://new-runner/agent/workspaces");
  const [searchUrl, searchInit] = fetchMock.mock.calls[2];
  expect(String(searchUrl)).toContain("http://new-runner/agent/session-history/search");
  expect(searchInit).toEqual(expect.objectContaining({
    headers: { authorization: "Bearer new-token" },
  }));
  fetchMock.mockRestore();
});

test("continues chat search across every registered directory in API-sized pages", async () => {
  const registeredDirectories = Array.from({ length: 9 }, (_, index) => ({
    id: `dir-${index}`,
    path: `/work/${index}`,
    displayName: `Directory ${index}`,
    markerColor: "none" as const,
  }));
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse(registeredDirectories.map((directory) => directory.path)))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) } as Response);
  const drawer = await renderDrawer({ registeredDirectories });
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "search all directories");
  await fireEvent(chatInput, "submitEditing");

  await waitFor(() => expect(drawer.getByText("検索を続ける")).toBeTruthy());
  const firstUrl = new URL(String(fetchMock.mock.calls[1][0]));
  expect(firstUrl.searchParams.getAll("cwd")).toEqual(
    registeredDirectories.slice(0, 8).map((directory) => directory.path)
  );

  await fireEvent.press(drawer.getByText("検索を続ける"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const secondUrl = new URL(String(fetchMock.mock.calls[2][0]));
  expect(secondUrl.searchParams.getAll("cwd")).toEqual(["/work/8"]);
  fetchMock.mockRestore();
});

test("keeps the period boundary fixed while continuing an API cursor", async () => {
  const firstNow = Date.parse("2026-08-31T00:00:00.000Z");
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(firstNow);
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("First page", "message-1")], cursor: "next" }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) } as Response);
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  await fireEvent.press(drawer.getByText("検索オプション"));
  await fireEvent.press(drawer.getByText("7日以内"));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "fixed period");
  await fireEvent(chatInput, "submitEditing");

  await waitFor(() => expect(drawer.getByText("First page")).toBeTruthy());
  nowSpy.mockReturnValue(firstNow + 60_000);
  await fireEvent.press(drawer.getByText("検索を続ける"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

  const firstUrl = new URL(String(fetchMock.mock.calls[1][0]));
  const secondUrl = new URL(String(fetchMock.mock.calls[2][0]));
  expect(secondUrl.searchParams.get("cursor")).toBe("next");
  expect(secondUrl.searchParams.get("since")).toBe(firstUrl.searchParams.get("since"));
  expect(firstUrl.searchParams.get("since")).toBe("2026-08-24T00:00:00.000Z");
  nowSpy.mockRestore();
  fetchMock.mockRestore();
});

test("removes old results immediately when the chat query changes", async () => {
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("Old query result", "old-message")] }),
    } as Response)
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("New query result", "new-message")] }),
    } as Response);
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "old query");
  await fireEvent(chatInput, "submitEditing");
  await waitFor(() => expect(drawer.getByText("Old query result")).toBeTruthy());

  await fireEvent.changeText(chatInput, "new query");
  expect(drawer.queryByText("Old query result")).toBeNull();
  expect(drawer.getByText("検索キーで検索します。")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await fireEvent(chatInput, "submitEditing");
  await waitFor(() => expect(drawer.getByText("New query result")).toBeTruthy());
  fetchMock.mockRestore();
});

test("removes old results immediately when a chat search option changes", async () => {
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("Newest result", "newest-message")] }),
    } as Response)
    .mockResolvedValueOnce(workspacesResponse())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [conversationSearchResult("Oldest result", "oldest-message")] }),
    } as Response);
  const drawer = await renderDrawer();
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "sort result");
  await fireEvent(chatInput, "submitEditing");
  await waitFor(() => expect(drawer.getByText("Newest result")).toBeTruthy());

  await fireEvent.press(drawer.getByText("検索オプション"));
  await fireEvent.press(drawer.getByText("古い順"));
  expect(drawer.queryByText("Newest result")).toBeNull();
  expect(drawer.getByText("検索キーで検索します。")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await fireEvent(chatInput, "submitEditing");
  await waitFor(() => expect(drawer.getByText("Oldest result")).toBeTruthy());
  const secondUrl = new URL(String(fetchMock.mock.calls[3][0]));
  expect(secondUrl.searchParams.get("order")).toBe("oldest");
  fetchMock.mockRestore();
});

test("searches only registered directories confirmed by the runner", async () => {
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(workspacesResponse(["/work/valid", "/work/unrelated"]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) } as Response);
  const drawer = await renderDrawer({
    registeredDirectories: [
      { id: "relative", path: ".", displayName: "Relative", markerColor: "none" },
      { id: "missing", path: "/work/missing", displayName: "Missing", markerColor: "none" },
      { id: "valid", path: "/work/valid", displayName: "Valid", markerColor: "none" },
    ],
  });
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "absolute only");
  expect(drawer.getByText("登録済みディレクトリ 3件")).toBeTruthy();
  await fireEvent(chatInput, "submitEditing");

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(drawer.getByText("検索可能なディレクトリ 1件を順に検索")).toBeTruthy();
  const url = new URL(String(fetchMock.mock.calls[1][0]));
  expect(url.searchParams.getAll("cwd")).toEqual(["/work/valid"]);
  fetchMock.mockRestore();
});

test("does not call chat search when the runner confirms no registered directory", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(workspacesResponse(["/work/unrelated"]));
  const drawer = await renderDrawer({
    registeredDirectories: [
      { id: "dot", path: ".", displayName: "Current", markerColor: "none" },
      { id: "nested", path: "relative/path", displayName: "Nested", markerColor: "none" },
    ],
  });
  const searchInput = drawer.getByPlaceholderText("ディレクトリを検索");
  await fireEvent(searchInput, "focus");
  await fireEvent.press(drawer.getByRole("tab", { name: "チャット" }));
  const chatInput = drawer.getByPlaceholderText("チャット内を検索");
  await fireEvent.changeText(chatInput, "nothing valid");
  await fireEvent(chatInput, "submitEditing");

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/agent/workspaces");
  expect(drawer.getByText("検索対象の登録ディレクトリがありません。")).toBeTruthy();
  expect(drawer.getByText("検索可能なディレクトリ 0件を順に検索")).toBeTruthy();
  fetchMock.mockRestore();
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
