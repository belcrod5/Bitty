import { act, renderHook } from "@testing-library/react-native";
import { getAgentBackendStatuses } from "../../agent/client";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { useAgentModelCatalog } from "./useAgentModelCatalog";

jest.mock("../../agent/client", () => ({
  getAgentBackendStatuses: jest.fn(),
}));

test("refreshes once per ready generation and when the picker opens", async () => {
  const getStatuses = getAgentBackendStatuses as jest.MockedFunction<typeof getAgentBackendStatuses>;
  getStatuses.mockReset();
  getStatuses.mockResolvedValue([{
    backendId: "codex",
    capabilities: {
      model: {
        effort: true,
        catalog: [{ modelId: "gpt-test", label: "GPT Test" }],
      },
    },
  }]);
  let generation = 1;
  let subscriber = () => {};
  const manager = {
    getSnapshot: () => ({ connectionState: "ready", generation }),
    subscribeSnapshot: (next: () => void) => {
      subscriber = next;
      return () => {};
    },
  } as unknown as RunnerWebSocketManager;

  const { result, rerender } = await renderHook<ReturnType<typeof useAgentModelCatalog>, { pickerOpen: boolean }>(
    ({ pickerOpen }) => useAgentModelCatalog({
      runnerWebSocketManager: manager,
      backendId: "codex",
      modelId: "gpt-test",
      pickerOpen,
      settingsLoaded: true,
      selectionLocked: false,
      setModelId: jest.fn(),
    }),
    { initialProps: { pickerOpen: false } },
  );
  expect(getStatuses).toHaveBeenCalledTimes(1);
  expect(result.current[0]?.selectionKey).toBe("codex::gpt-test");

  await act(async () => { subscriber(); });
  expect(getStatuses).toHaveBeenCalledTimes(1);
  generation = 2;
  await act(async () => { subscriber(); });
  expect(getStatuses).toHaveBeenCalledTimes(2);

  await rerender({ pickerOpen: true });
  expect(getStatuses).toHaveBeenCalledTimes(3);
});

test.each(["", "retired-model"])("selects the first advertised model for an unmaterialized draft with model %p", async (modelId) => {
  const getStatuses = getAgentBackendStatuses as jest.MockedFunction<typeof getAgentBackendStatuses>;
  getStatuses.mockReset();
  let resolveStatuses: (statuses: Awaited<ReturnType<typeof getAgentBackendStatuses>>) => void = () => {};
  getStatuses.mockReturnValue(new Promise((resolve) => { resolveStatuses = resolve; }));
  const setModelId = jest.fn();
  const manager = {
    getSnapshot: () => ({ connectionState: "ready", generation: 1 }),
    subscribeSnapshot: () => () => {},
  } as unknown as RunnerWebSocketManager;

  const { result, rerender } = await renderHook<ReturnType<typeof useAgentModelCatalog>, { settingsLoaded: boolean }>(
    ({ settingsLoaded }) => useAgentModelCatalog({
      runnerWebSocketManager: manager,
      backendId: "codex",
      modelId,
      pickerOpen: false,
      settingsLoaded,
      selectionLocked: false,
      setModelId,
    }),
    { initialProps: { settingsLoaded: false } },
  );
  expect(result.current).toEqual(modelId ? [expect.objectContaining({ modelId, selectable: false })] : []);
  expect(setModelId).not.toHaveBeenCalled();

  await act(async () => resolveStatuses([{
    backendId: "codex",
    capabilities: { model: { catalog: [{ modelId: "first-upstream", label: "First Upstream" }] } },
  }]));
  expect(setModelId).not.toHaveBeenCalled();
  await rerender({ settingsLoaded: true });
  expect(setModelId).toHaveBeenCalledWith("first-upstream");
});

test("keeps a materialized session's historical model as an unselectable display fallback", async () => {
  const getStatuses = getAgentBackendStatuses as jest.MockedFunction<typeof getAgentBackendStatuses>;
  getStatuses.mockReset();
  getStatuses.mockResolvedValue([{
    backendId: "codex",
    capabilities: { model: { catalog: [{ modelId: "current-model", label: "Current" }] } },
  }]);
  const setModelId = jest.fn();
  const manager = {
    getSnapshot: () => ({ connectionState: "ready", generation: 1 }),
    subscribeSnapshot: () => () => {},
  } as unknown as RunnerWebSocketManager;

  const { result } = await renderHook(() => useAgentModelCatalog({
    runnerWebSocketManager: manager,
    backendId: "codex",
    modelId: "historical-model",
    pickerOpen: false,
    settingsLoaded: true,
    selectionLocked: true,
    setModelId,
  }));
  expect(setModelId).not.toHaveBeenCalled();
  expect(result.current).toContainEqual(expect.objectContaining({ modelId: "historical-model", selectable: false }));
});
