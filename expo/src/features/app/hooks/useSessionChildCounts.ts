import { useEffect, useMemo, useRef, useState } from "react";
import { getAgentSessionChildCounts, subscribeSessionChildrenChanges, type AgentSessionChildCount } from "../../agent/client";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { runnerSessionKey } from "../utils/runnerClientState";

type ParentRef = AgentSessionChildCount["sessionRef"];

// The board consumes counts, not a retained subscription to every child's list.
export function useSessionChildCounts(manager: RunnerWebSocketManager, scope: string, parents: ParentRef[]) {
  const parentKey = JSON.stringify([...new Set(parents.map((ref) => runnerSessionKey(ref.backendId, ref.nativeSessionId)))].sort());
  const targets = useMemo<ParentRef[]>(() => JSON.parse(parentKey).map((key: string) => {
    const [backendId, nativeSessionId] = JSON.parse(key);
    return { backendId, nativeSessionId };
  }), [parentKey]);
  const targetsRef = useRef(new Map<string, ParentRef>());
  targetsRef.current = new Map(targets.map((ref) => {
    const key = runnerSessionKey(ref.backendId, ref.nativeSessionId);
    return [key, targetsRef.current.get(key) || ref];
  }));
  const refreshRef = useRef<(() => void) | null>(null);
  const currentScopeRef = useRef({ manager, scope });
  if (currentScopeRef.current.manager !== manager || currentScopeRef.current.scope !== scope) currentScopeRef.current = { manager, scope };
  const [state, setState] = useState<{ scope: object; counts: Map<string, AgentSessionChildCount>; loading: boolean }>({
    scope: currentScopeRef.current, counts: new Map(), loading: false,
  });
  useEffect(() => {
    const requestScope = currentScopeRef.current;
    const attempted = new Map<string, ParentRef>();
    let disposed = false, inFlight = false, dirty = false, lastReady = "";
    const isCurrent = () => !disposed && currentScopeRef.current === requestScope;
    const refresh = async (force = false) => {
      for (const key of attempted.keys()) if (!targetsRef.current.has(key)) attempted.delete(key);
      if (!isCurrent() || !targetsRef.current.size || manager.getSnapshot().connectionState !== "ready") return;
      if (force) attempted.clear();
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      do {
        dirty = false;
        const requested = new Map([...targetsRef.current].filter(([key, ref]) => attempted.get(key) !== ref));
        if (!requested.size) break;
        for (const [key, ref] of requested) attempted.set(key, ref);
        const initial = manager.getSnapshot();
        setState((previous) => ({ scope: requestScope, counts: previous.scope === requestScope ? previous.counts : new Map(), loading: true }));
        try {
          const result = await getAgentSessionChildCounts(manager, [...requested.values()]);
          const current = manager.getSnapshot();
          if (!isCurrent() || current.connectionState !== "ready" || current.generation !== initial.generation
            || current.connectionId !== initial.connectionId || current.url !== initial.url) continue;
          setState((previous) => {
            const counts = new Map(previous.scope === requestScope ? [...previous.counts].filter(([key]) => targetsRef.current.has(key)) : []);
            for (const count of result || []) {
              const key = runnerSessionKey(count.sessionRef.backendId, count.sessionRef.nativeSessionId);
              if (targetsRef.current.get(key) === requested.get(key)) counts.set(key, count);
            }
            return { scope: requestScope, counts, loading: false };
          });
        } catch {
          // Retry unknown/failed targets on an actual update or reconnect, while retaining known counts.
        }
      } while (dirty && isCurrent() && manager.getSnapshot().connectionState === "ready");
      inFlight = false;
      if (isCurrent()) setState((previous) => ({ ...previous, loading: false }));
    };
    refreshRef.current = () => { void refresh(); };
    const handleReady = () => {
      const snapshot = manager.getSnapshot();
      if (snapshot.connectionState !== "ready") return;
      const key = JSON.stringify([snapshot.generation, snapshot.connectionId, snapshot.url]);
      if (lastReady === key) return;
      lastReady = key;
      void refresh(true);
    };
    const unsubscribeReady = manager.subscribeSnapshot(handleReady);
    const unsubscribeChildren = subscribeSessionChildrenChanges(manager, (id, relationship, backendId) => {
      if (relationship === "child_completed" || [...targetsRef.current.values()].some((ref) => ref.nativeSessionId === id && ref.backendId === backendId)) void refresh(true);
    });
    const unsubscribeActive = manager.subscribe({ channel: "control", op: "sessions_active_changed" }, () => { void refresh(true); });
    handleReady();
    return () => { disposed = true; refreshRef.current = null; unsubscribeReady(); unsubscribeChildren(); unsubscribeActive(); };
  }, [manager, scope]);
  useEffect(() => {
    setState((previous) => ({ ...previous, counts: new Map([...previous.counts].filter(([key]) => targetsRef.current.has(key))) }));
    refreshRef.current?.();
  }, [targets]);
  return state.scope === currentScopeRef.current ? state : { counts: new Map<string, AgentSessionChildCount>(), loading: Boolean(targets.length) };
}
