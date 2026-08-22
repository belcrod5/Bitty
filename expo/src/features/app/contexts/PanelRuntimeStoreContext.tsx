import { createContext, useContext, type ReactNode } from "react";
import type { ConversationMessage } from "../types/appTypes";
import type { SessionActivity } from "../utils/statusIcons";

export type PanelRuntimeMarkerColor = "none" | "gray" | "red" | "yellow" | "green" | "black";

export type PanelRuntimeSnapshot = {
  panelId: string;
  backendId?: string;
  selectedSessionId: string;
  // false marks a local draft that has not been resolved to a provider-native session yet.
  sessionMaterialized?: boolean;
  selectedDirectoryPath: string;
  selectedDirectoryDisplayName: string;
  selectedSessionTitle: string;
  selectedSessionUpdatedAt: string;
  selectedSessionMarkerColor: PanelRuntimeMarkerColor;
  selectedThreadStatusType: string;
  modelRef: string;
  reasoningEffort: string;
  contextUsedPct: number | null;
  isResponding: boolean;
  runtimeStatus?: string;
  runtimeStatusDetail?: string;
  runtimeActivityTrail?: SessionActivity[];
  isHydrating?: boolean;
  requestStartedAtMs?: number;
  inheritedConversationMessages: ConversationMessage[];
  conversationMessages: ConversationMessage[];
  scrollOffsetY?: number;
  scrollViewportHeight?: number;
  scrollNearBottom?: boolean;
  ttsPlaybackMessageId?: string;
};

export type PanelRuntimeStoreContextValue = {
  getSnapshot: (panelId: string) => PanelRuntimeSnapshot;
  getKnownPanelIds: () => string[];
};

const PanelRuntimeStoreContext = createContext<PanelRuntimeStoreContextValue | null>(null);

type PanelRuntimeStoreProviderProps = {
  value: PanelRuntimeStoreContextValue;
  children: ReactNode;
};

export function PanelRuntimeStoreProvider({
  value,
  children,
}: PanelRuntimeStoreProviderProps) {
  return (
    <PanelRuntimeStoreContext.Provider value={value}>
      {children}
    </PanelRuntimeStoreContext.Provider>
  );
}

export function usePanelRuntimeStore() {
  const context = useContext(PanelRuntimeStoreContext);
  if (!context) {
    throw new Error("usePanelRuntimeStore must be used within PanelRuntimeStoreProvider");
  }
  return context;
}
