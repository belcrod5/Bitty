import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
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

export type PanelRuntimePreview = Readonly<Pick<PanelRuntimeSnapshot,
  "selectedSessionId" | "selectedSessionUpdatedAt" | "isResponding" | "isHydrating" | "runtimeActivityTrail"
> & {
  lastMessageContent: string;
  messageCount: number;
}>;

export type PanelRuntimeStoreContextValue = {
  subscribe: (sessionIds: readonly string[], listener: () => void) => () => void;
  getRevision: (sessionId: string) => number;
  getBaseSnapshot: (panelId: string) => PanelRuntimeSnapshot | undefined;
  getSnapshot: (panelId: string) => PanelRuntimeSnapshot;
  getPreview: (panelId: string) => PanelRuntimePreview;
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

export function usePanelRuntimeStore(panelIds: readonly string[]) {
  const context = useContext(PanelRuntimeStoreContext);
  if (!context) {
    throw new Error("usePanelRuntimeStore must be used within PanelRuntimeStoreProvider");
  }
  const { subscribe: subscribeToSessions, getRevision: readRevision } = context;
  const sessionKey = JSON.stringify([...new Set(panelIds.map((panelId) => (
    String(context.getBaseSnapshot(panelId)?.selectedSessionId || "").trim()
  )).filter(Boolean))].sort());
  const sessionIds = useMemo<string[]>(() => JSON.parse(sessionKey), [sessionKey]);
  const subscribe = useCallback((listener: () => void) => (
    subscribeToSessions(sessionIds, listener)
  ), [subscribeToSessions, sessionIds]);
  const getRevision = useCallback(() => (
    sessionIds.map((sessionId) => readRevision(sessionId)).join(":")
  ), [readRevision, sessionIds]);
  const revision = useSyncExternalStore(subscribe, getRevision, getRevision);
  return { getSnapshot: context.getSnapshot, getPreview: context.getPreview, getKnownPanelIds: context.getKnownPanelIds, revision };
}
