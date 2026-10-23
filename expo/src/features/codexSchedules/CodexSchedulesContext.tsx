import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { getCodexSchedules, putCodexSchedules } from "./codexScheduleApi";
import type { CodexSchedule, CodexScheduleSnapshot } from "./codexScheduleTypes";

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
  const [stored, setStored] = useState<{ scope: string; snapshot: CodexScheduleSnapshot } | null>(null);
  const snapshot = stored?.scope === scope ? stored.snapshot : null;
  const [nowMs, setNowMs] = useState(Date.now);
  const mounted = useRef(false);
  // Saving or changing Runner invalidates reads already in flight.
  const generation = useRef(0);
  const pendingRead = useRef<{ scope: string; request: Promise<CodexScheduleSnapshot> } | null>(null);

  const adopt = useCallback((next: CodexScheduleSnapshot) => {
    if (!mounted.current || currentScope.current !== scope) return;
    setNowMs(Date.now());
    setStored((current) => current?.scope === scope && JSON.stringify(current.snapshot) === JSON.stringify(next)
      ? current : { scope, snapshot: next });
  }, [scope]);
  const refresh = useCallback(() => {
    if (pendingRead.current?.scope === scope) return pendingRead.current.request;
    const requestGeneration = generation.current;
    const request = getCodexSchedules({ runnerUrl, runnerToken }).then((next) => {
      if (requestGeneration === generation.current) adopt(next);
      return next;
    }).finally(() => {
      if (pendingRead.current?.request === request) pendingRead.current = null;
    });
    pendingRead.current = { scope, request };
    return request;
  }, [adopt, runnerToken, runnerUrl, scope]);
  const save = useCallback(async (revision: number, schedules: readonly CodexSchedule[]) => {
    const requestGeneration = ++generation.current;
    pendingRead.current = null;
    const next = await putCodexSchedules({ runnerUrl, runnerToken }, revision, schedules);
    if (mounted.current && currentScope.current === scope && generation.current === requestGeneration) {
      ++generation.current;
      pendingRead.current = null;
      adopt(next);
    }
    return next;
  }, [adopt, runnerToken, runnerUrl, scope]);

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      if (AppState.currentState && AppState.currentState !== "active") return;
      setNowMs(Date.now());
      if (runnerUrl.trim() && runnerToken.trim()) void refresh().catch(() => {});
    };
    update();
    const timer = setInterval(update, 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNowMs(Date.now());
        if (runnerUrl.trim() && runnerToken.trim()) void refresh().catch(() => {});
      }
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      pendingRead.current = null;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh, runnerToken, runnerUrl]);

  const scheduledThreadIds = useMemo(() => new Set((snapshot?.schedules || []).flatMap((schedule) => (
    schedule.enabled && schedule.action.kind === "llm" && schedule.action.threadId
      && Date.parse(schedule.nextOccurrenceAt || "") > nowMs
      ? [schedule.action.threadId] : []
  ))), [nowMs, snapshot]);

  useEffect(() => {
    const next = Math.min(...(snapshot?.schedules || []).flatMap((schedule) => {
      const at = Date.parse(schedule.nextOccurrenceAt || "");
      return schedule.enabled && at > nowMs ? [at] : [];
    }));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => {
      setNowMs(Date.now());
      if (!AppState.currentState || AppState.currentState === "active") void refresh().catch(() => {});
    }, Math.min(2_147_483_647, Math.max(1, next - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [nowMs, refresh, snapshot]);

  const value = useMemo(() => ({ scheduledThreadIds, refresh, save }), [refresh, save, scheduledThreadIds]);
  return <CodexSchedulesContext.Provider value={value}>{children}</CodexSchedulesContext.Provider>;
}

export function useCodexSchedules() {
  const context = useContext(CodexSchedulesContext);
  if (!context) throw new Error("CodexSchedulesProvider is required");
  return context;
}
