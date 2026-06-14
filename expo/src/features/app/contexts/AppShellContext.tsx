import { createContext, useContext, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AppScreen } from "../types/appTypes";

export type AppShellContextValue = {
  activeScreen: AppScreen;
  drawerOpen: boolean;
  setActiveScreen: Dispatch<SetStateAction<AppScreen>>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  openDrawer: () => void;
  closeDrawer: () => void;
  openDebugScreen: () => void;
  openAudioLabScreen: () => void;
  openMiniBoardScreen: () => void;
};

const AppShellContext = createContext<AppShellContextValue | null>(null);

type AppShellProviderProps = {
  value: AppShellContextValue;
  children: ReactNode;
};

export function AppShellProvider({ value, children }: AppShellProviderProps) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error("useAppShell must be used within AppShellProvider");
  }
  return context;
}
