import { useState } from "react";
import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import type { LlmSessionHistoryEntry, RunnerSessionReadResult } from "./useLlmSessionExplorer";
import { useSessionMarkReadController } from "./useSessionMarkReadController";

function session(sessionId: string, directory = "/workspace"): LlmSessionHistoryEntry {
  return {
    sessionId,
    parentSessionId: "",
    directory,
    updatedAt: "2026-07-29T01:00:00.000Z",
    lastReadAt: "",
    source: "cli",
    cwd: directory,
    firstUserMessage: sessionId,
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "",
    reasoningEffort: "",
  };
}

function directoryState(entries: LlmSessionHistoryEntry[]): DirectorySessionTreeState {
  return {
    loading: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 1,
    error: "",
    latestSessionId: entries[0]?.sessionId || "",
    nextCursor: "",
    hasMore: false,
    entries,
    childrenByParentId: {},
  };
}

function marked(sessionId: string): RunnerSessionReadResult {
  return {
    sessionId,
    directory: "/workspace",
    source: "all",
    lastReadAt: "2026-07-29T02:00:00.000Z",
    updated: true,
    acpUpdated: false,
    cliUpdated: true,
    diagnostics: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function renderController({
  entries = [],
  markRunnerSessionRead = jest.fn(async (sessionId: unknown) => marked(String(sessionId))),
  fetchSessionHistory = jest.fn(async () => ({
    latestSessionId: entries[0]?.sessionId || "",
    nextCursor: "",
    entries,
  })),
  showChatBottomToast = jest.fn(),
}: {
  entries?: LlmSessionHistoryEntry[];
  markRunnerSessionRead?: jest.Mock;
  fetchSessionHistory?: jest.Mock;
  showChatBottomToast?: jest.Mock;
} = {}) {
  return renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<
      Record<string, DirectorySessionTreeState>
    >(entries.length > 0 ? { workspace: directoryState(entries) } : {});
    const controller = useSessionMarkReadController({
      markRunnerSessionRead,
      fetchSessionHistory,
      normalizedLlmDirectoryForRequest: () => "/workspace",
      setDirectorySessionsById,
      showChatBottomToast,
      logSessionDiag: jest.fn(),
      recordSessionReadDuringFetch: jest.fn(),
    });
    return { controller, directorySessionsById };
  });
}

test("reports directory progress and keeps each completed read when another request fails", async () => {
  const first = session("first", "/workspace/worktree/first");
  const second = session("second", "/workspace/worktree/second");
  const firstRead = deferred<RunnerSessionReadResult>();
  const secondRead = deferred<RunnerSessionReadResult>();
  const markRunnerSessionRead = jest.fn((sessionId: unknown) => (
    sessionId === "first" ? firstRead.promise : secondRead.promise
  ));
  const fetchSessionHistory = jest.fn(async () => ({
    latestSessionId: first.sessionId,
    nextCursor: "",
    entries: [first, second],
  }));
  const showChatBottomToast = jest.fn();
  const { result } = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<
      Record<string, DirectorySessionTreeState>
    >({
      workspace: directoryState([first, second]),
    });
    const controller = useSessionMarkReadController({
      markRunnerSessionRead,
      fetchSessionHistory,
      normalizedLlmDirectoryForRequest: () => "/workspace",
      setDirectorySessionsById,
      showChatBottomToast,
      logSessionDiag: jest.fn(),
      recordSessionReadDuringFetch: jest.fn(),
    });
    return { controller, directorySessionsById };
  });

  let batch!: Promise<boolean>;
  await act(async () => {
    batch = result.current.controller.markDirectorySessionsRead({
      directory: "/workspace",
    });
    await Promise.resolve();
  });

  expect(result.current.controller.directoryReadProgressByPath["/workspace"]).toEqual({
    completed: 0,
    total: 2,
  });
  expect(fetchSessionHistory).toHaveBeenCalledWith("/workspace", expect.objectContaining({
    includeSubagents: true,
  }));
  expect(markRunnerSessionRead).toHaveBeenCalledWith("first", {
    source: "all",
    directory: "/workspace/worktree/first",
  });
  expect(markRunnerSessionRead).toHaveBeenCalledWith("second", {
    source: "all",
    directory: "/workspace/worktree/second",
  });

  await act(async () => {
    firstRead.resolve(marked("first"));
    await Promise.resolve();
  });

  expect(result.current.controller.directoryReadProgressByPath["/workspace"]).toEqual({
    completed: 1,
    total: 2,
  });
  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe("2026-07-29T02:00:00.000Z");

  let completed = true;
  await act(async () => {
    secondRead.reject(new Error("runner unavailable"));
    completed = await batch;
  });

  expect(completed).toBe(false);
  expect(result.current.controller.directoryReadProgressByPath["/workspace"]).toBeUndefined();
  expect(result.current.directorySessionsById.workspace.entries[1].lastReadAt).toBe("");
  expect(showChatBottomToast).toHaveBeenLastCalledWith(
    "assistant",
    "1件を既読にしました。1件は失敗しました: runner unavailable"
  );
});

test("serializes read and unread mutations for the same session", async () => {
  const entry = session("same");
  const firstRead = deferred<RunnerSessionReadResult>();
  const markRunnerSessionRead = jest.fn((
    sessionId: unknown,
    options?: { lastReadAt?: unknown }
  ) => {
    if (markRunnerSessionRead.mock.calls.length === 1) return firstRead.promise;
    return Promise.resolve({
      ...marked(String(sessionId)),
      lastReadAt: String(options?.lastReadAt || marked(String(sessionId)).lastReadAt),
    });
  });
  const { result } = await renderController({
    entries: [entry],
    markRunnerSessionRead,
  });

  let read!: Promise<boolean>;
  let unread!: Promise<boolean>;
  await act(async () => {
    read = result.current.controller.markSessionRead({
      sessionId: "same",
      directory: "/workspace",
    });
    unread = result.current.controller.markSessionUnread({
      sessionId: "same",
      directory: "/workspace",
    });
    await Promise.resolve();
  });
  expect(markRunnerSessionRead).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstRead.resolve(marked("same"));
    expect(await read).toBe(true);
    expect(await unread).toBe(true);
  });

  expect(markRunnerSessionRead).toHaveBeenNthCalledWith(2, "same", {
    source: "all",
    directory: "/workspace",
    lastReadAt: new Date(0).toISOString(),
  });
  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe(new Date(0).toISOString());
});

test("rejects a successful HTTP response when Runner did not find the session", async () => {
  const entry = session("missing");
  const markRunnerSessionRead = jest.fn(async (): Promise<RunnerSessionReadResult> => ({
    ...marked("missing"),
    updated: false,
    cliUpdated: false,
    diagnostics: {
      acpEntryFound: false,
      cliEntryFound: false,
    },
  }));
  const showChatBottomToast = jest.fn();
  const { result } = await renderController({
    entries: [entry],
    markRunnerSessionRead,
    showChatBottomToast,
  });

  let succeeded = true;
  await act(async () => {
    succeeded = await result.current.controller.markSessionRead({
      sessionId: "missing",
      directory: "/workspace",
    });
  });

  expect(succeeded).toBe(false);
  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt).toBe("");
  expect(showChatBottomToast).toHaveBeenLastCalledWith(
    "assistant",
    "既読化に失敗しました: Runnerで対象セッションの既読状態を更新できませんでした"
  );
});

test("accepts an idempotent read when Runner confirms that the target exists", async () => {
  const entry = session("existing");
  const markRunnerSessionRead = jest.fn(async (): Promise<RunnerSessionReadResult> => ({
    ...marked("existing"),
    updated: false,
    cliUpdated: false,
    diagnostics: {
      acpEntryFound: false,
      cliEntryFound: true,
    },
  }));
  const { result } = await renderController({
    entries: [entry],
    markRunnerSessionRead,
  });

  let succeeded = false;
  await act(async () => {
    succeeded = await result.current.controller.markSessionRead({
      sessionId: "existing",
      directory: "/workspace",
    });
  });
  expect(succeeded).toBe(true);
});

test("prevents two directory batches for the same path from sharing progress", async () => {
  const history = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const fetchSessionHistory = jest.fn(() => history.promise);
  const { result } = await renderController({ fetchSessionHistory });

  let first!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  await act(async () => {
    first = result.current.controller.markDirectorySessionsRead({ directory: "/workspace" });
    duplicate = result.current.controller.markDirectorySessionsRead({ directory: "/workspace" });
    await Promise.resolve();
  });
  await expect(duplicate).resolves.toBe(false);
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1);

  await act(async () => {
    history.resolve({ latestSessionId: "", nextCursor: "", entries: [] });
    expect(await first).toBe(true);
  });
  expect(result.current.controller.directoryReadProgressByPath["/workspace"]).toBeUndefined();
});

test("handles an empty directory and a history enumeration error", async () => {
  const showChatBottomToast = jest.fn();
  const fetchSessionHistory = jest.fn()
    .mockResolvedValueOnce({ latestSessionId: "", nextCursor: "", entries: [] })
    .mockRejectedValueOnce(new Error("history unavailable"));
  const { result } = await renderController({
    fetchSessionHistory,
    showChatBottomToast,
  });

  await act(async () => {
    await expect(result.current.controller.markDirectorySessionsRead({ directory: "/empty" }))
      .resolves.toBe(true);
    await expect(result.current.controller.markDirectorySessionsRead({ directory: "/broken" }))
      .resolves.toBe(false);
  });
  expect(showChatBottomToast).toHaveBeenNthCalledWith(
    1,
    "assistant",
    "既読にする未読セッションはありません。"
  );
  expect(showChatBottomToast).toHaveBeenNthCalledWith(
    2,
    "assistant",
    "一括既読化に失敗しました: history unavailable"
  );
  expect(result.current.controller.directoryReadProgressByPath).toEqual({});
});

test("deduplicates paginated sessions and stops a cursor cycle", async () => {
  const first = session("first");
  const second = session("second");
  const fetchSessionHistory = jest.fn()
    .mockResolvedValueOnce({
      latestSessionId: "first",
      nextCursor: "page-2",
      entries: [first],
    })
    .mockResolvedValueOnce({
      latestSessionId: "first",
      nextCursor: "page-2",
      entries: [first, second],
    });
  const markRunnerSessionRead = jest.fn(async (sessionId: unknown) => marked(String(sessionId)));
  const { result } = await renderController({
    fetchSessionHistory,
    markRunnerSessionRead,
  });

  await act(async () => {
    await expect(result.current.controller.markDirectorySessionsRead({ directory: "/workspace" }))
      .resolves.toBe(true);
  });

  expect(fetchSessionHistory).toHaveBeenCalledTimes(2);
  expect(fetchSessionHistory).toHaveBeenNthCalledWith(2, "/workspace", expect.objectContaining({
    cursor: "page-2",
    includeSubagents: true,
  }));
  expect(markRunnerSessionRead.mock.calls.map(([sessionId]) => sessionId)).toEqual([
    "first",
    "second",
  ]);
});

test("limits directory reads to four concurrent Runner requests", async () => {
  const entries = Array.from({ length: 8 }, (_, index) => session(`session-${index}`));
  const requests: Array<{
    sessionId: string;
    pending: ReturnType<typeof deferred<RunnerSessionReadResult>>;
  }> = [];
  let active = 0;
  let maxActive = 0;
  const markRunnerSessionRead = jest.fn((sessionId: unknown) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const pending = deferred<RunnerSessionReadResult>();
    requests.push({ sessionId: String(sessionId), pending });
    return pending.promise.finally(() => {
      active -= 1;
    });
  });
  const { result } = await renderController({
    entries,
    markRunnerSessionRead,
  });

  let batch!: Promise<boolean>;
  await act(async () => {
    batch = result.current.controller.markDirectorySessionsRead({ directory: "/workspace" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(requests).toHaveLength(4);

  await act(async () => {
    for (const request of requests.slice(0, 4)) {
      request.pending.resolve(marked(request.sessionId));
    }
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(requests).toHaveLength(8);

  await act(async () => {
    for (const request of requests.slice(4)) {
      request.pending.resolve(marked(request.sessionId));
    }
    expect(await batch).toBe(true);
  });
  expect(maxActive).toBe(4);
});
