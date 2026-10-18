import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useOrchestratorActivities } from "../hooks/useOrchestratorActivities";
import { useRegisteredDirectoryActiveSessionCount } from "../hooks/useRegisteredDirectoryActiveSessionCount";
import { useChatScreen } from "./ChatScreenContext";
import { useChatDiagnostics } from "./ChatDiagnosticsContext";
import { parseCodexStatusLimit } from "../utils/codexAuthRateLimits";

const native = Platform.OS === "ios"
  ? requireOptionalNativeModule<{ setSnapshot: (json: string) => Promise<void> }>("BittyWidgets") : null;

// The widget uses the existing global overview only, never the original To Do or conversation text.
function widgetTaskOverview(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as { orchestratorId?: unknown; taskChecklistOverview?: unknown };
  if (value.orchestratorId && value.orchestratorId !== "main") return "";
  const overview = value.taskChecklistOverview as { status?: unknown; markdown?: unknown } | undefined;
  if (overview?.status !== "present" || typeof overview.markdown !== "string") return "";
  return overview.markdown.split(/\r?\n/u).map((line) => line
    .replace(/^\s*(?:[-*+]\s*)?\[[ xX]\]\s*/u, "")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/u, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1").trim())
    .filter(Boolean).slice(0, 8).join("\n").slice(0, 1200);
}

type Status = ReturnType<typeof useOrchestratorActivities> & { runningSessionCount: number | null };
const OrchestratorStatusContext = createContext<Status | null>(null);

export function OrchestratorStatusProvider({ children }: { children: ReactNode }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const diagnostics = useChatDiagnostics();
  const manager = useRunnerWebSocketManager();
  const { connected, generation, appState } = useRunnerWebSocketSnapshot();
  const status = useOrchestratorActivities(runnerUrl, runnerToken, true);
  const runningSessionCount = useRegisteredDirectoryActiveSessionCount();
  const [overview, setOverview] = useState({ text: "", fetchedAt: 0 });
  const [source, setSource] = useState({ runnerUrl, runnerToken });
  const sourceMatches = source.runnerUrl === runnerUrl && source.runnerToken === runnerToken;
  const previousJson = useRef("");

  useEffect(() => {
    setSource({ runnerUrl, runnerToken });
    setOverview({ text: "", fetchedAt: 0 });
    if (!native || !connected || appState !== "active") return;
    let current = true;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void manager.request({ channel: "agent", op: "voice.history", payload: { orchestratorId: "main" } })
        .then((response) => {
          if (!current || request !== revision) return;
          setOverview({ text: response.op === "voice.history.result" ? widgetTaskOverview(response.payload) : "",
            fetchedAt: Date.now() });
        }).catch(() => { if (current && request === revision) setOverview({ text: "", fetchedAt: 0 }); });
    };
    refresh();
    const unsubscribe = manager.subscribe({ channel: "agent", op: "voice.task-checklist.changed" }, refresh);
    return () => { current = false; unsubscribe(); };
  }, [appState, connected, generation, manager, runnerUrl, runnerToken]);

  useEffect(() => {
    if (!native || (appState !== "active" && sourceMatches)) return;
    const online = connected && sourceMatches;
    const usageKnown = online && !diagnostics.codexAuthSwitching && diagnostics.codexCliStatusFetchedAtMs > 0;
    // Only presentation data crosses the App Group boundary. Never persist Runner credentials or chat history.
    const data = {
      version: 1, connected: online,
      orchestrators: sourceMatches ? status.orchestrators.map(({ id, name, icon }) => ({ id, name, icon })) : [],
      selectedId: sourceMatches ? status.selectedId : "",
      runningCount: online ? runningSessionCount : null,
      overview: online ? overview.text : "", overviewFetchedAt: online ? overview.fetchedAt : 0,
      fiveHourRemaining: usageKnown ? parseCodexStatusLimit(diagnostics.codexCliStatusText, "5h").remainingPercent : null,
      weeklyRemaining: usageKnown ? parseCodexStatusLimit(diagnostics.codexCliStatusText, "Weekly").remainingPercent : null,
      usageLimitReached: usageKnown && Boolean(diagnostics.codexUsageLimitReached),
      usageFetchedAt: usageKnown ? diagnostics.codexCliStatusFetchedAtMs : 0,
    };
    const json = JSON.stringify(data);
    if (json === previousJson.current) return;
    const publish = () => {
      previousJson.current = json;
      void native.setSnapshot(json).catch(() => { previousJson.current = ""; });
    };
    if (!online) { publish(); return; }
    const timer = setTimeout(publish, 500);
    return () => clearTimeout(timer);
  }, [appState, connected, diagnostics.codexAuthProfileId, diagnostics.codexAuthSwitching, diagnostics.codexCliStatusFetchedAtMs,
    diagnostics.codexCliStatusText, diagnostics.codexUsageLimitReached, overview, runningSessionCount,
    sourceMatches, status.orchestrators, status.selectedId]);

  return <OrchestratorStatusContext.Provider value={{ ...status, runningSessionCount }}>
    {children}
  </OrchestratorStatusContext.Provider>;
}

export function useOrchestratorStatus() {
  const value = useContext(OrchestratorStatusContext);
  if (!value) throw new Error("useOrchestratorStatus must be used within OrchestratorStatusProvider");
  return value;
}
