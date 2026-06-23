import { useCallback, useRef } from "react";

export function usePanelHydrationGuard() {
  const generationByPanelIdRef = useRef<Record<string, number>>({});

  const invalidatePanelHydration = useCallback((panelId: string) => {
    generationByPanelIdRef.current[panelId] = (generationByPanelIdRef.current[panelId] || 0) + 1;
  }, []);

  const beginPanelHydration = useCallback((panelId: string) => {
    invalidatePanelHydration(panelId);
    const generation = generationByPanelIdRef.current[panelId];
    return () => generationByPanelIdRef.current[panelId] === generation;
  }, [invalidatePanelHydration]);

  return {
    beginPanelHydration,
    invalidatePanelHydration,
  };
}
