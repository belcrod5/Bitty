import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
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
  subscribe: (sessionIds: readonly string[], listener: () => void) => () => void;
  getRevision: (sessionId: string) => number;
  getBaseSnapshot: (panelId: string) => PanelRuntimeSnapshot | undefined;
  projectSnapshot: (panelId: string, base: PanelRuntimeSnapshot) => PanelRuntimeSnapshot;
  createEmptySnapshot: (panelId: string) => PanelRuntimeSnapshot;
  getKnownPanelIds: () => string[];
};

type PanelRuntimeStore = PanelRuntimeStoreContextValue & {
  getSnapshot: (panelId: string) => PanelRuntimeSnapshot;
};

const PanelRuntimeStoreContext = createContext<PanelRuntimeStore | null>(null);

type PanelRuntimeStoreProviderProps = {
  value: PanelRuntimeStoreContextValue;
  children: ReactNode;
};

export function PanelRuntimeStoreProvider({
  value,
  children,
}: PanelRuntimeStoreProviderProps) {
  const cache = useRef(new WeakMap<PanelRuntimeSnapshot, {
    panelId: string;
    revision: number;
    project: PanelRuntimeStoreContextValue["projectSnapshot"];
    snapshot: PanelRuntimeSnapshot;
  }>());
  const getSnapshot = useCallback((panelId: string) => {
    const base = value.getBaseSnapshot(panelId);
    if (!base) return value.createEmptySnapshot(panelId);
    const revision = value.getRevision(base.selectedSessionId);
    const cached = cache.current.get(base);
    if (cached?.panelId === panelId && cached.revision === revision && cached.project === value.projectSnapshot) {
      return cached.snapshot;
    }
    const snapshot = value.projectSnapshot(panelId, base);
    cache.current.set(base, { panelId, revision, project: value.projectSnapshot, snapshot });
    return snapshot;
  }, [value.createEmptySnapshot, value.getBaseSnapshot, value.getRevision, value.projectSnapshot]);
  const store = useMemo(() => ({ ...value, getSnapshot }), [getSnapshot, value]);
  return (
    <PanelRuntimeStoreContext.Provider value={store}>
      {children}
    </PanelRuntimeStoreContext.Provider>
  );
}

export function usePanelRuntimeStore(panelIds: readonly string[]) {
  const context = useContext(PanelRuntimeStoreContext);
  if (!context) {
    throw new Error("usePanelRuntimeStore must be used within PanelRuntimeStoreProvider");
  }
  const sessionKey = JSON.stringify([...new Set(panelIds.map((panelId) => (
    String(context.getBaseSnapshot(panelId)?.selectedSessionId || "").trim()
  )).filter(Boolean))].sort());
  const sessionIds = useMemo<string[]>(() => JSON.parse(sessionKey), [sessionKey]);
  const subscribe = useCallback((listener: () => void) => (
    context.subscribe(sessionIds, listener)
  ), [context.subscribe, sessionIds]);
  const getRevision = useCallback(() => (
    sessionIds.map((sessionId) => context.getRevision(sessionId)).join(":")
  ), [context.getRevision, sessionIds]);
  const revision = useSyncExternalStore(subscribe, getRevision, getRevision);
  return { getSnapshot: context.getSnapshot, getKnownPanelIds: context.getKnownPanelIds, revision };
}
