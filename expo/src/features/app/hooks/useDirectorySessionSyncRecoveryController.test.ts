import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionSyncState } from "../types/directorySessions";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";
import { useDirectorySessionSyncRecoveryController } from "./useDirectorySessionSyncRecoveryController";

function createFakeManager(initial: { connectionState: string; generation: number }) {
  let snapshot = initial;
  const handlers = new Set<() => void>();
  return {
    manager: {
      getSnapshot: () => snapshot,
      subscribeSnapshot: (handler: () => void) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    setSnapshot(next: { connectionState: string; generation: number }) {
      snapshot = next;
      for (const handler of [...handlers]) handler();
    },
  };
}

function syncState(
  phase: DirectorySessionSyncState["phase"],
  cycleId = 1
): DirectorySessionSyncState {
  return {
    ...IDLE_DIRECTORY_SESSION_SYNC,
    phase,
    cycleId,
    totalCount: 1,
    failedCount: phase === "error" || phase === "partial_error" ? 1 : 0,
  };
}

async function renderRecovery(
  manager: ReturnType<typeof createFakeManager>["manager"],
  initialSync: DirectorySessionSyncState
) {
  const ensureRegisteredDirectorySessions = jest.fn().mockResolvedValue(undefined);
  const hook = await renderHook((sync: DirectorySessionSyncState) => {
    useDirectorySessionSyncRecoveryController({
      runnerWebSocketManager: manager,
      directorySessionSync: sync,
      ensureRegisteredDirectorySessions,
      logSessionDiag: jest.fn(),
    });
  }, { initialProps: initialSync });
  return { rerender: hook.rerender, ensureRegisteredDirectorySessions };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test("retries a failed sync when the runner WS becomes ready", async () => {
  const { manager, setSnapshot } = createFakeManager({ connectionState: "connecting", generation: 0 });
  const { ensureRegisteredDirectorySessions } = await renderRecovery(manager, syncState("error"));

  // 起動時: WS ready前にensureが全滅 → phase error のまま ready遷移が起きる。
  await act(async () => {
    setSnapshot({ connectionState: "ready", generation: 1 });
  });

  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledWith("auth_recovery");
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(1);

  // 同一generationの再通知では再試行しない。
  await act(async () => {
    setSnapshot({ connectionState: "ready", generation: 1 });
  });
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(1);
});

test("does not retry on ready transitions while the sync is healthy", async () => {
  const { manager, setSnapshot } = createFakeManager({ connectionState: "connecting", generation: 0 });
  const { ensureRegisteredDirectorySessions, rerender } = await renderRecovery(manager, syncState("idle"));

  await act(async () => {
    setSnapshot({ connectionState: "ready", generation: 1 });
  });
  await rerender(syncState("complete"));
  await act(async () => {
    jest.runOnlyPendingTimers();
  });

  expect(ensureRegisteredDirectorySessions).not.toHaveBeenCalled();
});

test("schedules a bounded delayed retry when a cycle fails while the WS is ready", async () => {
  const { manager, setSnapshot } = createFakeManager({ connectionState: "ready", generation: 1 });
  const { ensureRegisteredDirectorySessions, rerender } = await renderRecovery(manager, syncState("idle"));

  // ready中に失敗確定(サイクル途中でreadyになった等)→ 遅延再試行。
  await rerender(syncState("partial_error", 2));
  expect(ensureRegisteredDirectorySessions).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(1);

  // 2回目までは再試行、それ以降は同一generation内で打ち止め(無限ループ防止)。
  await rerender(syncState("error", 3));
  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(2);

  await rerender(syncState("error", 4));
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(2);

  // 新しいready遷移(再接続)でリトライ枠がリセットされ、即時再試行する。
  await act(async () => {
    setSnapshot({ connectionState: "ready", generation: 2 });
  });
  expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(3);
});

test("skips the delayed retry when the WS is no longer ready at fire time", async () => {
  const { manager, setSnapshot } = createFakeManager({ connectionState: "ready", generation: 1 });
  const { ensureRegisteredDirectorySessions, rerender } = await renderRecovery(manager, syncState("idle"));

  await rerender(syncState("error", 2));
  await act(async () => {
    setSnapshot({ connectionState: "reconnecting", generation: 1 });
    jest.advanceTimersByTime(4000);
  });

  // 切断中は遅延再試行せず、次のready遷移側の再試行に任せる。
  expect(ensureRegisteredDirectorySessions).not.toHaveBeenCalled();
});
