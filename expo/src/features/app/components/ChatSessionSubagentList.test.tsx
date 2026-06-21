import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ChatSessionSubagentList } from "./ChatSessionSubagentList";
import type { DirectorySessionTreeState } from "./AppDrawer";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";

function session(overrides: Partial<LlmSessionHistoryEntry>): LlmSessionHistoryEntry {
  return {
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
  });
  const directoryState: DirectorySessionTreeState = {
    loading: false,
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
      selectedDirectoryPath="/work/bitty"
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
    sessionId: "parent",
    source: "cli",
    directory: "/work/bitty",
  });
});
