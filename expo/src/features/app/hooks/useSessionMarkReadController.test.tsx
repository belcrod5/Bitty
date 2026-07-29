import { useState } from "react";
import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import type { LlmSessionHistoryEntry, RunnerSessionReadResult } from "./useLlmSessionExplorer";
import { useSessionMarkReadController } from "./useSessionMarkReadController";

function session(sessionId: string): LlmSessionHistoryEntry {
  return {
    sessionId,
    parentSessionId: "",
    directory: "/workspace",
    updatedAt: "2026-07-29T01:00:00.000Z",
    lastReadAt: "",
    source: "cli",
    cwd: "/workspace",
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
    source: "cli",
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

type ControllerArgs = Parameters<typeof useSessionMarkReadController>[0];

async function renderControllerHarness(
  entries: LlmSessionHistoryEntry[],
  markRunnerSessionRead: ControllerArgs["markRunnerSessionRead"],
  fetchSessionHistory: ControllerArgs["fetchSessionHistory"] = jest.fn(async () => ({
    latestSessionId: entries[0]?.sessionId || "",
    nextCursor: "",
    entries,
  }))
) {
  const showChatBottomToast = jest.fn();
  const hook = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({
      workspace: directoryState(entries),
    });
    const controller = useSessionMarkReadController({
      markRunnerSessionRead,
      fetchSessionHistory,
      normalizedLlmDirectoryForRequest: () => "/workspace",
      setDirectorySessionsById,
      showChatBottomToast,
      logSessionDiag: jest.fn(),
    });
    return { controller, directorySessionsById };
  });
  return { ...hook, fetchSessionHistory, showChatBottomToast };
}

test("keeps successful directory read updates when another session fails", async () => {
  const first = session("first");
  const second = session("second");
  const markRunnerSessionRead = jest.fn(async (sessionId: unknown) => {
    if (sessionId === "second") throw new Error("runner unavailable");
    return marked(String(sessionId));
  });
  const { result, showChatBottomToast } = await renderControllerHarness(
    [first, second],
    markRunnerSessionRead
  );

  let completed = true;
  await act(async () => {
    completed = await result.current.controller.markDirectorySessionsRead({
      directory: "/workspace",
    });
  });

  expect(completed).toBe(false);
  expect(result.current.directorySessionsById.workspace.entries).toEqual([
    { ...first, lastReadAt: "2026-07-29T02:00:00.000Z" },
    second,
  ]);
  expect(showChatBottomToast).toHaveBeenLastCalledWith(
    "assistant",
    "1件を既読にしました。1件は失敗しました: runner unavailable"
  );
});

test("excludes a directory result replaced by a successful unread action from its toast", async () => {
  const first = session("first");
  const second = session("second");
  const pendingSecond = deferred<RunnerSessionReadResult>();
  const markRunnerSessionRead = jest.fn((
    sessionId: unknown,
    opts?: { lastReadAt?: unknown }
  ) => {
    if (sessionId === "second") return pendingSecond.promise;
    if (opts?.lastReadAt) {
      return Promise.resolve({
        ...marked("first"),
        lastReadAt: String(opts.lastReadAt),
      });
    }
    return Promise.resolve(marked("first"));
  });
  const { result, showChatBottomToast } = await renderControllerHarness(
    [first, second],
    markRunnerSessionRead
  );

  let directoryRead!: Promise<boolean>;
  await act(async () => {
    directoryRead = result.current.controller.markDirectorySessionsRead({
      directory: "/workspace",
    });
    await Promise.resolve();
  });
  await act(async () => {
    await result.current.controller.markSessionUnread({
      sessionId: "first",
      source: "cli",
      directory: "/workspace",
    });
  });
  await act(async () => {
    pendingSecond.resolve(marked("second"));
    await directoryRead;
  });

  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe("1970-01-01T00:00:00.000Z");
  expect(showChatBottomToast).not.toHaveBeenCalledWith("assistant", "2件を既読にしました。");
  expect(showChatBottomToast).toHaveBeenLastCalledWith("assistant", "1件を既読にしました。");
});

test("keeps a successful directory read when the queued unread action fails", async () => {
  const first = session("first");
  const second = session("second");
  const pendingSecond = deferred<RunnerSessionReadResult>();
  const markRunnerSessionRead = jest.fn((
    sessionId: unknown,
    opts?: { lastReadAt?: unknown }
  ) => {
    if (sessionId === "second") return pendingSecond.promise;
    if (opts?.lastReadAt) return Promise.reject(new Error("unread failed"));
    return Promise.resolve(marked("first"));
  });
  const { result } = await renderControllerHarness([first, second], markRunnerSessionRead);

  let directoryRead!: Promise<boolean>;
  await act(async () => {
    directoryRead = result.current.controller.markDirectorySessionsRead({
      directory: "/workspace",
    });
    await Promise.resolve();
  });
  await act(async () => {
    await expect(result.current.controller.markSessionUnread({
      sessionId: "first",
      source: "cli",
      directory: "/workspace",
    })).resolves.toBe(false);
  });
  await act(async () => {
    pendingSecond.reject(new Error("runner unavailable"));
    await directoryRead;
  });

  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe("2026-07-29T02:00:00.000Z");
});

test("serializes mutations for the same session in call order", async () => {
  const first = session("first");
  const pendingRead = deferred<RunnerSessionReadResult>();
  const markRunnerSessionRead = jest.fn((
    sessionId: unknown,
    opts?: { lastReadAt?: unknown }
  ) => (
    opts?.lastReadAt
      ? Promise.resolve({ ...marked(String(sessionId)), lastReadAt: String(opts.lastReadAt) })
      : pendingRead.promise
  ));
  const { result } = await renderControllerHarness([first], markRunnerSessionRead);

  const read = result.current.controller.markSessionRead({
    sessionId: "first",
    source: "cli",
    directory: "/workspace",
  });
  const unread = result.current.controller.markSessionUnread({
    sessionId: "first",
    source: "cli",
    directory: "/workspace",
  });

  expect(markRunnerSessionRead).toHaveBeenCalledTimes(1);
  await act(async () => {
    pendingRead.resolve(marked("first"));
    await read;
    await unread;
  });

  expect(markRunnerSessionRead).toHaveBeenCalledTimes(2);
  expect(markRunnerSessionRead.mock.calls[1]?.[1]).toMatchObject({
    lastReadAt: "1970-01-01T00:00:00.000Z",
  });
  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe("1970-01-01T00:00:00.000Z");
});

test("continues and cleans up a session queue after a rejected mutation", async () => {
  const first = session("first");
  const markRunnerSessionRead = jest.fn(async (
    sessionId: unknown,
    opts?: { lastReadAt?: unknown }
  ) => {
    if (!opts?.lastReadAt) throw new Error("read failed");
    return {
      ...marked(String(sessionId)),
      lastReadAt: String(opts.lastReadAt),
    };
  });
  const { result } = await renderControllerHarness([first], markRunnerSessionRead);

  await act(async () => {
    await expect(result.current.controller.markSessionRead({
      sessionId: "first",
      source: "cli",
      directory: "/workspace",
    })).resolves.toBe(false);
  });
  await act(async () => {
    const unread = result.current.controller.markSessionUnread({
      sessionId: "first",
      source: "cli",
      directory: "/workspace",
    });
    expect(markRunnerSessionRead).toHaveBeenCalledTimes(2);
    await expect(unread).resolves.toBe(true);
  });
});

test("includes unexpanded subagent sessions in a directory read", async () => {
  const parent = session("parent");
  const child = {
    ...session("child"),
    parentSessionId: parent.sessionId,
    source: "subagent" as const,
  };
  const markRunnerSessionRead = jest.fn(async (sessionId: unknown) => marked(String(sessionId)));
  const fetchSessionHistory = jest.fn(async () => ({
    latestSessionId: parent.sessionId,
    nextCursor: "",
    entries: [parent, child],
  }));
  const { result } = await renderControllerHarness(
    [parent],
    markRunnerSessionRead,
    fetchSessionHistory
  );

  await act(async () => {
    await result.current.controller.markDirectorySessionsRead({
      directory: "/workspace",
    });
  });

  expect(fetchSessionHistory).toHaveBeenCalledWith("/workspace", expect.objectContaining({
    includeSubagents: true,
  }));
  expect(markRunnerSessionRead).toHaveBeenCalledWith("child", {
    source: "subagent",
    directory: "/workspace",
  });
});
