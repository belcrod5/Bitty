import React, { type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react-native";
import { PanelRuntimeStoreProvider, usePanelRuntimeStore, type PanelRuntimeSnapshot } from "./PanelRuntimeStoreContext";
import { useConversationRuntimeStoreController } from "../hooks/useConversationRuntimeStoreController";
import { buildPanelRuntimeSnapshot } from "../utils/panelRuntimeSnapshot";

function panel(panelId: string, modelRef: string): PanelRuntimeSnapshot {
  return {
    panelId, selectedSessionId: "session-a", selectedDirectoryPath: "/workspace",
    selectedDirectoryDisplayName: "Workspace", selectedSessionTitle: panelId,
    selectedSessionUpdatedAt: "", selectedSessionMarkerColor: "none",
    selectedThreadStatusType: "idle", modelRef, reasoningEffort: "", contextUsedPct: null,
    isResponding: false, inheritedConversationMessages: [], conversationMessages: [],
  };
}

test("follows reassignment, local panel settings, and compact projection changes without a shared cache", async () => {
  let runtime!: ReturnType<typeof useConversationRuntimeStoreController>;
  let setBases!: React.Dispatch<React.SetStateAction<Record<string, PanelRuntimeSnapshot>>>;
  let setCompact!: React.Dispatch<React.SetStateAction<boolean>>;
  const projected = jest.fn();
  let renders = 0;
  function Wrapper({ children }: PropsWithChildren) {
    runtime = useConversationRuntimeStoreController();
    const [bases, updateBases] = React.useState<Record<string, PanelRuntimeSnapshot>>({ left: panel("left", "model-a"), right: panel("right", "model-b") });
    const [compact, updateCompact] = React.useState(false);
    setBases = updateBases;
    setCompact = updateCompact;
    const projectSnapshot = React.useCallback((panelId: string, base: PanelRuntimeSnapshot) => {
      projected(panelId);
      const snapshot = runtime.getConversationRuntimeSnapshot(base.selectedSessionId);
      return buildPanelRuntimeSnapshot({
        panelId, base, isCompactRunning: () => compact,
        patch: snapshot ? {
          contextUsedPct: snapshot.contextUsedPct, isResponding: snapshot.isResponding,
          selectedThreadStatusType: snapshot.selectedThreadStatusType,
          conversationMessages: snapshot.conversationMessages,
        } : {},
      });
    }, [compact]);
    const value = React.useMemo(() => ({
      getBaseSnapshot: (panelId: string) => bases[panelId],
      getSnapshot: (panelId: string) => projectSnapshot(panelId, bases[panelId]),
      getPreview: (panelId: string) => ({
        selectedSessionId: bases[panelId].selectedSessionId, selectedSessionUpdatedAt: "",
        isResponding: false, lastMessageContent: "", messageCount: 0,
      }),
      getKnownPanelIds: () => Object.keys(bases),
      subscribe: runtime.subscribeConversationRuntime, getRevision: runtime.getConversationRuntimeRevision,
    }), [bases, projectSnapshot]);
    return <PanelRuntimeStoreProvider value={value}>{children}</PanelRuntimeStoreProvider>;
  }
  const { result } = await renderHook(() => {
    renders += 1;
    const [panelIds, setPanelIds] = React.useState(["left", "right"]);
    const { getSnapshot } = usePanelRuntimeStore(panelIds);
    return { left: getSnapshot("left"), right: panelIds.includes("right") ? getSnapshot("right") : null, setPanelIds };
  }, { wrapper: Wrapper });
  await act(() => {
    runtime.upsertConversationRuntimeSnapshot({ sessionId: "session-a", contextUsedPct: 10, selectedThreadStatusType: "idle" });
    runtime.upsertConversationRuntimeSnapshot({ sessionId: "session-b", contextUsedPct: 20, selectedThreadStatusType: "idle" });
  });
  expect(runtime.getConversationRuntimeRevision("session-a")).toBe(runtime.getConversationRuntimeRevision("session-b"));
  expect(result.current.left.modelRef).toBe("model-a");
  expect(result.current.right?.modelRef).toBe("model-b");
  projected.mockClear();
  await act(() => {
    setBases((bases) => ({ ...bases, left: { ...bases.left, selectedSessionId: "session-b", selectedSessionTitle: "New assignment" } }));
  });
  expect(result.current.left).toMatchObject({ selectedSessionId: "session-b", selectedSessionTitle: "New assignment", contextUsedPct: 20 });
  expect(result.current.right?.modelRef).toBe("model-b");
  expect(projected.mock.calls.map(([panelId]) => panelId)).toEqual(["left", "right"]);
  await act(() => { result.current.setPanelIds(["left"]); });
  const afterAssignment = renders;
  projected.mockClear();
  await act(() => { runtime.upsertConversationRuntimeSnapshot({ sessionId: "session-a", contextUsedPct: 30 }); });
  expect(renders).toBe(afterAssignment);
  expect(projected).not.toHaveBeenCalled();
  await act(() => { runtime.upsertConversationRuntimeSnapshot({ sessionId: "session-b", contextUsedPct: 40 }); });
  expect(result.current.left.contextUsedPct).toBe(40);
  expect(projected.mock.calls.map(([panelId]) => panelId)).toEqual(["left"]);
  await act(() => { setBases((bases) => ({ ...bases, left: { ...bases.left, reasoningEffort: "high" } })); });
  expect(result.current.left.reasoningEffort).toBe("high");
  expect(result.current.left.selectedThreadStatusType).toBe("idle");
  await act(() => { setCompact(true); });
  expect(result.current.left.selectedThreadStatusType).toBe("active");
});
