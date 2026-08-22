import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAgentBackendStatuses, type BackendStatus } from "../../agent/client";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { LlmBackend } from "../types/appTypes";
import {
  currentModelFallback,
  modelOptionsFromStatuses,
} from "../modelOptions";

type UseAgentModelCatalogOptions = {
  runnerWebSocketManager: RunnerWebSocketManager;
  backendId: LlmBackend;
  modelId: string;
  pickerOpen: boolean;
};

export function useAgentModelCatalog({
  runnerWebSocketManager,
  backendId,
  modelId,
  pickerOpen,
}: UseAgentModelCatalogOptions) {
  const [backendStatuses, setBackendStatuses] = useState<BackendStatus[]>([]);
  const refreshInFlightRef = useRef(false);
  const lastReadyGenerationRef = useRef(-1);
  const refresh = useCallback(async () => {
    if (runnerWebSocketManager.getSnapshot().connectionState !== "ready" || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const statuses = await getAgentBackendStatuses(runnerWebSocketManager);
      if (statuses.length > 0) setBackendStatuses(statuses);
    } catch {
      // Keep the last catalog and current selection while the Runner is unavailable.
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [runnerWebSocketManager]);

  useEffect(() => {
    const refreshOnReadyGeneration = () => {
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (snapshot.connectionState !== "ready" || snapshot.generation === lastReadyGenerationRef.current) return;
      lastReadyGenerationRef.current = snapshot.generation;
      void refresh();
    };
    refreshOnReadyGeneration();
    return runnerWebSocketManager.subscribeSnapshot(refreshOnReadyGeneration);
  }, [refresh, runnerWebSocketManager]);
  useEffect(() => {
    if (pickerOpen) void refresh();
  }, [pickerOpen, refresh]);

  return useMemo(() => {
    const catalog = modelOptionsFromStatuses(backendStatuses);
    const status = backendStatuses.find((item) => item.backendId === backendId);
    const capability = {
      ...status?.capabilities?.model,
      schedule: status?.capabilities?.operations?.schedule,
      compactQueue: status?.capabilities?.operations?.compactQueue,
    };
    return catalog.some((option) => option.backendId === backendId && option.modelId === modelId)
      ? catalog
      : [...catalog, currentModelFallback(backendId, modelId, capability)];
  }, [backendId, backendStatuses, modelId]);
}
