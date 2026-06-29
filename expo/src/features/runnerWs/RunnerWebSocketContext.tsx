import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { RunnerWebSocketManager } from "./RunnerWebSocketManager";
import type { RunnerWsAppState } from "./types";

const RunnerWebSocketContext = createContext<RunnerWebSocketManager | null>(null);

type RunnerWebSocketProviderProps = {
  url: string;
  token: string;
  manager?: RunnerWebSocketManager;
  children: ReactNode;
};

function normalizeAppState(value: AppStateStatus | RunnerWsAppState | undefined): RunnerWsAppState {
  if (value === "active" || value === "inactive" || value === "background") return value;
  return "unknown";
}

export function RunnerWebSocketProvider({
  url,
  token,
  manager,
  children,
}: RunnerWebSocketProviderProps) {
  const managerRef = useRef<RunnerWebSocketManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = manager || new RunnerWebSocketManager({
      url,
      token,
      appState: normalizeAppState(AppState.currentState),
    });
  }
  const stableManager = managerRef.current;

  useEffect(() => {
    stableManager.setConnectionOptions({ url, token });
  }, [stableManager, token, url]);

  useEffect(() => {
    stableManager.setAppState(normalizeAppState(AppState.currentState));
    const subscription = AppState.addEventListener("change", (nextState) => {
      stableManager.setAppState(normalizeAppState(nextState));
    });
    return () => subscription.remove();
  }, [stableManager]);

  return (
    <RunnerWebSocketContext.Provider value={stableManager}>
      {children}
    </RunnerWebSocketContext.Provider>
  );
}

export function useRunnerWebSocketManager() {
  const manager = useContext(RunnerWebSocketContext);
  if (!manager) {
    throw new Error("RunnerWebSocketProvider is required");
  }
  return manager;
}

export function useRunnerWebSocketSnapshot() {
  const manager = useRunnerWebSocketManager();
  return useSyncExternalStore(
    manager.subscribeSnapshot,
    manager.getSnapshot,
    manager.getSnapshot
  );
}
