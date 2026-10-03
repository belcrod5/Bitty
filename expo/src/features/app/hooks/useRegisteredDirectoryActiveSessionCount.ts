import { useEffect, useMemo, useState } from "react";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useAppShell } from "../contexts/AppShellContext";
import { useConversation } from "../contexts/ConversationContext";

export function useRegisteredDirectoryActiveSessionCount() {
  const { activeScreen } = useAppShell();
  const { registeredDirectories } = useConversation();
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const directoryKey = useMemo(() => Array.from(new Set(
    registeredDirectories.map(({ path }) => path.trim()).filter(Boolean)
  )).sort().join("\u0000"), [registeredDirectories]);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!connected || activeScreen !== "skia_board") {
      setCount(null);
      return;
    }
    if (!directoryKey) {
      setCount(0);
      return;
    }
    let current = true;
    let inFlight = false;
    let refreshPending = false;
    const refresh = () => {
      if (inFlight) {
        refreshPending = true;
        return;
      }
      inFlight = true;
      void manager.request({
        channel: "agent",
        op: "sessions.active-count",
        payload: { cwds: directoryKey.split("\u0000") },
      }, { timeoutMs: 60_000 }).then((response) => {
        if (!current || refreshPending) return;
        const value = response.op === "sessions.active-count.result"
          ? (response.payload as { count?: unknown })?.count
          : null;
        setCount(typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
      }).catch(() => {
        if (current && !refreshPending) setCount(null);
      }).finally(() => {
        inFlight = false;
        if (current && refreshPending) {
          refreshPending = false;
          refresh();
        }
      });
    };
    setCount(null);
    refresh();
    const unsubscribeEvents = manager.subscribe({ channel: "agent", op: "event" }, (message) => {
      const type = (message.payload as { type?: string } | null)?.type;
      if (["session.resolved", "turn.started", "turn.completed", "turn.interrupted", "turn.failed"].includes(type || "")) refresh();
    });
    const unsubscribeAccepted = manager.subscribe({ channel: "agent", op: "turn.accepted" }, refresh);
    const timer = setInterval(() => { if (!inFlight) refresh(); }, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
      unsubscribeEvents();
      unsubscribeAccepted();
    };
  }, [activeScreen, connected, directoryKey, generation, manager]);

  return count;
}
