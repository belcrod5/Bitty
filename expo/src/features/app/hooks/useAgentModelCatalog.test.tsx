import { act, renderHook } from "@testing-library/react-native";
import { getAgentBackendStatuses } from "../../agent/client";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { useAgentModelCatalog } from "./useAgentModelCatalog";

jest.mock("../../agent/client", () => ({
  getAgentBackendStatuses: jest.fn(),
}));

test("refreshes once per ready generation and when the picker opens", async () => {
  const getStatuses = getAgentBackendStatuses as jest.MockedFunction<typeof getAgentBackendStatuses>;
  getStatuses.mockResolvedValue([{
    backendId: "codex",
    capabilities: {
      model: {
        effort: true,
        changeWithinSession: true,
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
