import { createContext, useContext, type ReactNode } from "react";
import type { LlmRuntimeLimitsSnapshot } from "../types/appTypes";

export type DebugRuntimeContextValue = {
  codexWsProbeLoading: boolean;
  probeCurrentWs: () => void;
  codexWsHandshakeProbeLoading: boolean;
  probeHandshakeOnly: () => void;
  codexWsDiagLoading: boolean;
  runWsDiag: () => void;
  runner8788SuiteLoading: boolean;
  runAuxServerSuite: () => void;
  codexWsE2eLoading: boolean;
  runWsE2e: () => void;
  codexWsHandshakeProbeStatus: string;
  codexWsDiagStatus: string;
  runner8788SuiteStatus: string;
  codexWsE2eStatus: string;
  llmRuntimeLimitsLoading: boolean;
  loadLlmRuntimeLimits: () => void;
  llmToolMaxRoundsInput: string;
  changeLlmToolMaxRoundsInput: (value: string) => void;
  llmToolMaxRoundsSaving: boolean;
  updateLlmToolMaxRounds: () => void;
  llmRuntimeLimits: LlmRuntimeLimitsSnapshot | null;
  llmRuntimeLimitsError: string;
  llmToolLogCompact: boolean;
  toggleLlmToolLogCompact: (value: boolean) => void;
};

const DebugRuntimeContext = createContext<DebugRuntimeContextValue | null>(null);

type DebugRuntimeProviderProps = {
  value: DebugRuntimeContextValue;
  children: ReactNode;
};

export function DebugRuntimeProvider({ value, children }: DebugRuntimeProviderProps) {
  return <DebugRuntimeContext.Provider value={value}>{children}</DebugRuntimeContext.Provider>;
}

export function useDebugRuntime() {
  const context = useContext(DebugRuntimeContext);
  if (!context) {
    throw new Error("useDebugRuntime must be used within DebugRuntimeProvider");
  }
  return context;
}
