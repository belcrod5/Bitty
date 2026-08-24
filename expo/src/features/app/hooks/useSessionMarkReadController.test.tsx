import { act, renderHook } from "@testing-library/react-native";
import type { DirectoryLoadOutcome } from "../types/directorySessions";
import type {
  RunnerDirectoryReadResult,
  RunnerSessionReadResult,
} from "./useLlmSessionExplorer";
import { useSessionMarkReadController } from "./useSessionMarkReadController";

function marked(
  sessionId: string,
  lastReadAt = "2026-07-29T02:00:00.000Z",
  directory = "/workspace"
): RunnerSessionReadResult {
  return {
    backendId: "codex",
    sessionId,
    directory,
    source: "all",
    lastReadAt,
    updated: true,
    acpUpdated: false,
    agentUpdated: false,
    cliUpdated: true,
    diagnostics: null,
  };
}

function directoryResult(overrides: Partial<RunnerDirectoryReadResult> = {}): RunnerDirectoryReadResult {
  return {
    scope: "directory",
    status: "full",
    directory: "/canonical/workspace",
    source: "all",
    lastReadAt: "2026-07-29T02:00:00.000Z",
    selectedCount: 205,
    foundCount: 205,
    updatedCount: 200,
    stores: {
      acp: { status: "success", selectedCount: 5, foundCount: 5, updatedCount: 5 },
      agent: { status: "success", selectedCount: 0, foundCount: 0, updatedCount: 0 },
      cli: { status: "success", selectedCount: 205, foundCount: 205, updatedCount: 200 },
    },
    diagnostics: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

const successfulReconcile: DirectoryLoadOutcome = {
  status: "success",
  directoryId: "workspace",
  directoryPath: "/workspace",
  state: {} as never,
};

async function renderController(overrides: {
  markRunnerSessionRead?: jest.Mock;
  markRunnerDirectoryRead?: jest.Mock;
  applySession?: jest.Mock;
  applyDirectory?: jest.Mock;
  reconcileDirectory?: jest.Mock;
  onSessionCommitted?: jest.Mock;
  onDirectoryCommitted?: jest.Mock;
  showToast?: jest.Mock;
} = {}) {
  const dependencies = {
    markRunnerSessionRead: overrides.markRunnerSessionRead
      || jest.fn(async (sessionId: unknown) => marked(String(sessionId))),
    markRunnerDirectoryRead: overrides.markRunnerDirectoryRead
      || jest.fn(async () => directoryResult()),
    applySession: overrides.applySession || jest.fn(),
    applyDirectory: overrides.applyDirectory || jest.fn(),
    reconcileDirectory: overrides.reconcileDirectory || jest.fn(async () => successfulReconcile),
    onSessionCommitted: overrides.onSessionCommitted || jest.fn(),
    onDirectoryCommitted: overrides.onDirectoryCommitted || jest.fn(async () => {}),
    showToast: overrides.showToast || jest.fn(),
  };
  const rendered = await renderHook(() => useSessionMarkReadController({
    markRunnerSessionRead: dependencies.markRunnerSessionRead,
    markRunnerDirectoryRead: dependencies.markRunnerDirectoryRead,
    normalizedLlmDirectoryForRequest: () => "/workspace",
    applySessionLastReadAtByIdToDirectoryTrees: dependencies.applySession,
    applyDirectoryLastReadAtToDirectoryTrees: dependencies.applyDirectory,
    reconcileDirectorySessionTree: dependencies.reconcileDirectory,
    onSessionReadStateCommitted: dependencies.onSessionCommitted,
    onDirectoryReadStateCommitted: dependencies.onDirectoryCommitted,
    showChatBottomToast: dependencies.showToast,
    logSessionDiag: jest.fn(),
  }));
  return { result: rendered.result, dependencies };
}

test("marks a large directory with one request and applies canonical full success", async () => {
  const pending = deferred<RunnerDirectoryReadResult>();
  const markRunnerDirectoryRead = jest.fn(() => pending.promise);
  const { result, dependencies } = await renderController({ markRunnerDirectoryRead });

  let operation!: Promise<boolean>;
  await act(async () => {
    operation = result.current.markDirectorySessionsRead({ directory: "/alias/workspace" });
    await Promise.resolve();
  });
  expect(markRunnerDirectoryRead).toHaveBeenCalledTimes(1);
  expect(markRunnerDirectoryRead).toHaveBeenCalledWith("/alias/workspace");
  expect(result.current.directoryReadProgressByPath["/alias/workspace"]).toEqual({
    completed: 0,
    total: 0,
  });

  const response = directoryResult();
  await act(async () => {
    pending.resolve(response);
    await expect(operation).resolves.toBe(true);
  });
  expect(dependencies.applyDirectory).toHaveBeenCalledWith(
    "/canonical/workspace",
    response.lastReadAt
  );
  expect(dependencies.reconcileDirectory).not.toHaveBeenCalled();
  expect(dependencies.onDirectoryCommitted).toHaveBeenCalledWith(response);
  expect(result.current.directoryReadProgressByPath["/alias/workspace"]).toBeUndefined();
});

test("treats an empty directory as a full success without enumerating sessions", async () => {
  const empty = directoryResult({ selectedCount: 0, foundCount: 0, updatedCount: 0 });
  const markRunnerDirectoryRead = jest.fn(async () => empty);
  const { result, dependencies } = await renderController({ markRunnerDirectoryRead });

  await act(async () => {
    await expect(result.current.markDirectorySessionsRead({ directory: "/empty" }))
      .resolves.toBe(true);
  });
  expect(markRunnerDirectoryRead).toHaveBeenCalledTimes(1);
  expect(dependencies.showToast).toHaveBeenCalledWith(
    "assistant",
    "既読にするセッションはありません。"
  );
});

test("does not optimistically apply a partial directory result and reconciles authority", async () => {
  const partial = directoryResult({
    status: "partial",
    selectedCount: 101,
    foundCount: 101,
    updatedCount: 80,
    stores: {
      acp: { status: "failed", selectedCount: 0, foundCount: 0, updatedCount: 0, reason: "eacces" },
      agent: { status: "success", selectedCount: 0, foundCount: 0, updatedCount: 0 },
      cli: { status: "success", selectedCount: 101, foundCount: 101, updatedCount: 80 },
    },
  });
  const { result, dependencies } = await renderController({
    markRunnerDirectoryRead: jest.fn(async () => partial),
  });

  await act(async () => {
    await expect(result.current.markDirectorySessionsRead({ directory: "/workspace" }))
      .resolves.toBe(false);
  });
  expect(dependencies.applyDirectory).not.toHaveBeenCalled();
  expect(dependencies.reconcileDirectory).toHaveBeenCalledWith(
    "/canonical/workspace",
    "/workspace"
  );
  expect(dependencies.onDirectoryCommitted).toHaveBeenCalledWith(partial);
  expect(dependencies.showToast).toHaveBeenCalledWith(
    "assistant",
    "80件を既読にしました。一部ストアの失敗後、表示を正本に再同期しました。"
  );
});

test.each(["failed", "superseded"])(
  "reports a %s authoritative reconcile instead of claiming success",
  async (status) => {
    const partial = directoryResult({ status: "partial", updatedCount: 3 });
    const { result, dependencies } = await renderController({
      markRunnerDirectoryRead: jest.fn(async () => partial),
      reconcileDirectory: jest.fn(async () => ({ status })),
    });

    await act(async () => {
      await expect(result.current.markDirectorySessionsRead({ directory: "/workspace" }))
        .resolves.toBe(false);
    });
    expect(dependencies.applyDirectory).not.toHaveBeenCalled();
    expect(dependencies.onDirectoryCommitted).toHaveBeenCalledWith(partial);
    expect(dependencies.showToast).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("一括既読処理を完了できませんでした")
    );
    expect(dependencies.showToast).not.toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("表示を正本に再同期しました")
    );
  }
);

test("prevents duplicate directory requests for the same path", async () => {
  const pending = deferred<RunnerDirectoryReadResult>();
  const markRunnerDirectoryRead = jest.fn(() => pending.promise);
  const { result } = await renderController({ markRunnerDirectoryRead });

  let first!: Promise<boolean>;
  await act(async () => {
    first = result.current.markDirectorySessionsRead({ directory: "/workspace" });
    await expect(result.current.markDirectorySessionsRead({ directory: "/workspace" }))
      .resolves.toBe(false);
  });
  expect(markRunnerDirectoryRead).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(directoryResult());
    await first;
  });
});

test("a later singular unread waits for directory reconciliation and wins local ordering", async () => {
  const directoryPending = deferred<RunnerDirectoryReadResult>();
  const markRunnerDirectoryRead = jest.fn(() => directoryPending.promise);
  const markRunnerSessionRead = jest.fn(async (_sessionId: unknown, options?: { lastReadAt?: unknown }) => (
    marked("session-1", String(options?.lastReadAt || ""), "/canonical/workspace")
  ));
  const reconcilePending = deferred<{ status: "success" }>();
  const reconcileDirectory = jest.fn(() => reconcilePending.promise);
  const { result, dependencies } = await renderController({
    markRunnerDirectoryRead,
    markRunnerSessionRead,
    reconcileDirectory,
  });

  let directory!: Promise<boolean>;
  let unread!: Promise<boolean>;
  await act(async () => {
    directory = result.current.markDirectorySessionsRead({ directory: "/alias" });
    await Promise.resolve();
    unread = result.current.markSessionUnread({ sessionId: "session-1", directory: "/canonical/workspace" });
    await Promise.resolve();
  });
  expect(markRunnerSessionRead).not.toHaveBeenCalled();
  await act(async () => {
    directoryPending.resolve(directoryResult({ status: "partial" }));
    await Promise.resolve();
  });
  expect(markRunnerSessionRead).not.toHaveBeenCalled();
  await act(async () => {
    reconcilePending.resolve({ status: "success" });
    await Promise.all([directory, unread]);
  });
  expect(markRunnerSessionRead).toHaveBeenCalledWith("session-1", {
    source: "all",
    directory: "/canonical/workspace",
    lastReadAt: new Date(0).toISOString(),
  });
  expect(dependencies.applySession).toHaveBeenLastCalledWith(
    new Map([["session-1", new Date(0).toISOString()]]),
    "/canonical/workspace",
    "codex",
  );
  expect(dependencies.onSessionCommitted).toHaveBeenLastCalledWith({
    backendId: "codex",
    sessionId: "session-1",
    directory: "/canonical/workspace",
    isRead: false,
  });
});

test("serializes read and unread mutations for the same session", async () => {
  const firstRead = deferred<RunnerSessionReadResult>();
  let callCount = 0;
  const markRunnerSessionRead = jest.fn((sessionId: unknown, options?: { lastReadAt?: unknown }) => {
    callCount += 1;
    return callCount === 1
      ? firstRead.promise
      : Promise.resolve(marked(String(sessionId), String(options?.lastReadAt || "")));
  });
  const { result } = await renderController({ markRunnerSessionRead });

  let read!: Promise<boolean>;
  let unread!: Promise<boolean>;
  await act(async () => {
    read = result.current.markSessionRead({ sessionId: "same", directory: "/workspace" });
    unread = result.current.markSessionUnread({ sessionId: "same", directory: "/workspace" });
    await Promise.resolve();
  });
  expect(markRunnerSessionRead).toHaveBeenCalledTimes(1);
  await act(async () => {
    firstRead.resolve(marked("same"));
    await Promise.all([read, unread]);
  });
  expect(markRunnerSessionRead).toHaveBeenCalledTimes(2);
});

test("rejects a singular response when Runner did not find the session", async () => {
  const showToast = jest.fn();
  const { result, dependencies } = await renderController({
    showToast,
    markRunnerSessionRead: jest.fn(async () => ({
      ...marked("missing"),
      updated: false,
      cliUpdated: false,
      diagnostics: { acpEntryFound: false, cliEntryFound: false },
    })),
  });
  await act(async () => {
    await expect(result.current.markSessionRead({ sessionId: "missing", directory: "/workspace" }))
      .resolves.toBe(false);
  });
  expect(dependencies.applySession).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    "assistant",
    "既読化に失敗しました: Runnerで対象セッションの既読状態を更新できませんでした"
  );
});
