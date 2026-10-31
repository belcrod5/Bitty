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
  const currentScopeRef = useRef({ manager, scope });
  if (currentScopeRef.current.manager !== manager || currentScopeRef.current.scope !== scope) currentScopeRef.current = { manager, scope };
  const [state, setState] = useState<{ scope: object; counts: Map<string, AgentSessionChildCount>; loading: boolean }>({
    scope: currentScopeRef.current, counts: new Map(), loading: false,
  });
  useEffect(() => {
    const requestScope = currentScopeRef.current;
    let disposed = false, inFlight = false, dirty = false, lastReady = "";
    const isCurrent = () => !disposed && currentScopeRef.current === requestScope;
    const refresh = async () => {
      if (!isCurrent() || !targets.length || manager.getSnapshot().connectionState !== "ready") return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      do {
        dirty = false;
        const initial = manager.getSnapshot();
        setState((previous) => ({ scope: requestScope, counts: previous.scope === requestScope ? previous.counts : new Map(), loading: true }));
        try {
          const result = await getAgentSessionChildCounts(manager, targets);
          const current = manager.getSnapshot();
          if (!isCurrent() || current.connectionState !== "ready" || current.generation !== initial.generation
            || current.connectionId !== initial.connectionId || current.url !== initial.url) continue;
          setState((previous) => {
            const requested = new Set(targets.map((ref) => runnerSessionKey(ref.backendId, ref.nativeSessionId)));
            const counts = new Map(previous.scope === requestScope ? [...previous.counts].filter(([key]) => requested.has(key)) : []);
            for (const count of result || []) counts.set(runnerSessionKey(count.sessionRef.backendId, count.sessionRef.nativeSessionId), count);
            return { scope: requestScope, counts, loading: false };
          });
        } catch {
          // Partial backend failures and offline resumes retain the last known
          // counts. An unsupported old Runner never falls back to full lists.
        }
      } while (dirty && isCurrent() && manager.getSnapshot().connectionState === "ready");
      inFlight = false;
      if (isCurrent()) setState((previous) => ({ ...previous, loading: false }));
    };
    const handleReady = () => {
      const snapshot = manager.getSnapshot();
      if (snapshot.connectionState !== "ready") return;
      const key = JSON.stringify([snapshot.generation, snapshot.connectionId, snapshot.url]);
      if (lastReady === key) return;
      lastReady = key;
      void refresh();
    };
    const unsubscribeReady = manager.subscribeSnapshot(handleReady);
    const unsubscribeChildren = subscribeSessionChildrenChanges(manager, (id, relationship, backendId) => {
      if (relationship === "child_completed" || targets.some((ref) => ref.nativeSessionId === id && ref.backendId === backendId)) void refresh();
    });
    const unsubscribeActive = manager.subscribe({ channel: "control", op: "sessions_active_changed" }, () => { void refresh(); });
    handleReady();
    return () => { disposed = true; unsubscribeReady(); unsubscribeChildren(); unsubscribeActive(); };
  }, [manager, scope, targets]);
  return state.scope === currentScopeRef.current ? state : { counts: new Map<string, AgentSessionChildCount>(), loading: Boolean(targets.length) };
}
