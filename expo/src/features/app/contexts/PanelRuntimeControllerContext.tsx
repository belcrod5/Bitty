import { createContext, useContext, type ReactNode } from "react";

export type PanelRuntimeControllerContextValue = {
  clearPanelSnapshot: (panelId: string) => void;
  copyPanelSnapshot: (sourcePanelId: string, targetPanelId: string) => void;
  setPanelAutoSpeechOpen: (panelId: string, open: boolean) => void;
  updatePanelSettings: (
    panelId: string,
    settings: { modelRef?: string; reasoningEffort?: string }
  ) => void;
  startNewPanelSession: (params: {
    panelId: string;
    directory: string;
  }) => string;
  hydratePanelFromSessionHistory: (params: {
    panelId: string;
    sessionId: string;
    directory: string;
    directoryDisplayName?: string;
    diagnosticCycleId?: string;
    title?: string;
    updatedAt?: string;
    modelRef?: string;
    reasoningEffort?: string;
    contextUsedPct?: number | null;
  }) => Promise<boolean>;
};

const PanelRuntimeControllerContext = createContext<PanelRuntimeControllerContextValue | null>(null);

type PanelRuntimeControllerProviderProps = {
  value: PanelRuntimeControllerContextValue;
  children: ReactNode;
};

export function PanelRuntimeControllerProvider({
  value,
  children,
}: PanelRuntimeControllerProviderProps) {
  return (
    <PanelRuntimeControllerContext.Provider value={value}>
      {children}
    </PanelRuntimeControllerContext.Provider>
  );
}

export function usePanelRuntimeController() {
  const context = useContext(PanelRuntimeControllerContext);
  if (!context) {
    throw new Error("usePanelRuntimeController must be used within PanelRuntimeControllerProvider");
  }
  return context;
}
