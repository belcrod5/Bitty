import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { getCodexSchedules, getCodexScheduleSummary, putCodexSchedules } from "./codexScheduleApi";
import { codexScheduleSummary, type CodexSchedule, type CodexScheduleSnapshot, type CodexScheduleSummary } from "./codexScheduleTypes";

type Auth = { runnerUrl: string; runnerToken: string };
type CodexSchedulesContextValue = {
  scheduledThreadIds: ReadonlySet<string>;
  refresh: () => Promise<CodexScheduleSnapshot>;
  save: (revision: number, schedules: readonly CodexSchedule[]) => Promise<CodexScheduleSnapshot>;
};

const CodexSchedulesContext = createContext<CodexSchedulesContextValue | null>(null);

export function CodexSchedulesProvider({ runnerUrl, runnerToken, children }: Auth & { children: ReactNode }) {
  const scope = JSON.stringify([runnerUrl, runnerToken]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [stored, setStored] = useState<{ scope: string; summary: CodexScheduleSummary } | null>(null);
  const summary = stored?.scope === scope ? stored.summary : null;
  const [nowMs, setNowMs] = useState(Date.now);
  const mounted = useRef(false);
  // Saving or changing Runner invalidates reads already in flight.
  const generation = useRef(0);
  const readNumber = useRef(0);
  const pendingRead = useRef<{ scope: string; request: Promise<CodexScheduleSnapshot> } | null>(null);

  const pendingSummary = useRef<{ scope: string; request: Promise<void> } | null>(null);
  const adopt = useCallback((next: CodexScheduleSnapshot | CodexScheduleSummary) => {
    if (!mounted.current || currentScope.current !== scope) return;
    const summary = "scheduledThreads" in next ? next : codexScheduleSummary(next);
    setNowMs(Date.now());
    setStored((current) => current?.scope === scope && JSON.stringify(current.summary) === JSON.stringify(summary)
      ? current : { scope, summary });
  }, [scope]);
  const refresh = useCallback(() => {
    if (pendingRead.current?.scope === scope) return pendingRead.current.request;
    const requestGeneration = generation.current;
    const requestNumber = ++readNumber.current;
    pendingSummary.current = null;
    const request = getCodexSchedules({ runnerUrl, runnerToken }).then((next) => {
      if (requestGeneration === generation.current && requestNumber === readNumber.current) adopt(next);
      return next;
    }).finally(() => {
      if (pendingRead.current?.request === request) pendingRead.current = null;
    });
    pendingRead.current = { scope, request };
    return request;
  }, [adopt, runnerToken, runnerUrl, scope]);
  const refreshSummary = useCallback(() => {
    if (pendingSummary.current?.scope === scope) return pendingSummary.current.request;
    const requestGeneration = generation.current;
    const requestNumber = ++readNumber.current;
    const request = getCodexScheduleSummary({ runnerUrl, runnerToken }).then((next) => {
      if (requestGeneration === generation.current && requestNumber === readNumber.current) adopt(next);
    }).finally(() => {
      if (pendingSummary.current?.request === request) pendingSummary.current = null;
    });
    pendingSummary.current = { scope, request };
    return request;
  }, [adopt, runnerToken, runnerUrl, scope]);
  const save = useCallback(async (revision: number, schedules: readonly CodexSchedule[]) => {
    const requestGeneration = ++generation.current;
    pendingRead.current = null;
    pendingSummary.current = null;
    const next = await putCodexSchedules({ runnerUrl, runnerToken }, revision, schedules);
    if (mounted.current && currentScope.current === scope && generation.current === requestGeneration) {
      ++generation.current;
      pendingRead.current = null;
      pendingSummary.current = null;
      adopt(next);
    }
    return next;
  }, [adopt, runnerToken, runnerUrl, scope]);

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      if (AppState.currentState && AppState.currentState !== "active") return;
      setNowMs(Date.now());
      if (runnerUrl.trim() && runnerToken.trim()) void refreshSummary().catch(() => {});
    };
    update();
    const timer = setInterval(update, 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNowMs(Date.now());
        if (runnerUrl.trim() && runnerToken.trim()) void refreshSummary().catch(() => {});
      }
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      pendingRead.current = null;
      pendingSummary.current = null;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refreshSummary, runnerToken, runnerUrl]);

  const scheduledThreadIds = useMemo(() => new Set((summary?.scheduledThreads || []).flatMap((entry) =>
    Date.parse(entry.nextOccurrenceAt) > nowMs ? [entry.threadId] : [])), [nowMs, summary]);

  useEffect(() => {
    const next = Math.min(...(summary?.scheduledThreads || []).map((entry) => Date.parse(entry.nextOccurrenceAt))
      .filter((at) => at > nowMs));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => {
      setNowMs(Date.now());
      if (!AppState.currentState || AppState.currentState === "active") void refreshSummary().catch(() => {});
    }, Math.min(2_147_483_647, Math.max(1, next - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [nowMs, refreshSummary, summary]);

  const value = useMemo(() => ({ scheduledThreadIds, refresh, save }), [refresh, save, scheduledThreadIds]);
  return <CodexSchedulesContext.Provider value={value}>{children}</CodexSchedulesContext.Provider>;
}

export function useCodexSchedules() {
  const context = useContext(CodexSchedulesContext);
  if (!context) throw new Error("CodexSchedulesProvider is required");
  return context;
}
