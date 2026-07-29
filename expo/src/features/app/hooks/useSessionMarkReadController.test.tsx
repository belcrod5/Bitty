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

test("keeps successful directory read updates when another session fails", async () => {
  const first = session("first");
  const second = session("second");
  const markRunnerSessionRead = jest.fn(async (sessionId: unknown) => {
    if (sessionId === "second") throw new Error("runner unavailable");
    return marked(String(sessionId));
  });
  const showChatBottomToast = jest.fn();
  const { result } = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({
      workspace: directoryState([first, second]),
    });
    const controller = useSessionMarkReadController({
      markRunnerSessionRead,
      fetchSessionHistory: async () => ({
        latestSessionId: first.sessionId,
        nextCursor: "",
        entries: [first, second],
      }),
      normalizedLlmDirectoryForRequest: () => "/workspace",
      setDirectorySessionsById,
      showChatBottomToast,
      logSessionDiag: jest.fn(),
    });
    return { controller, directorySessionsById };
  });

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
