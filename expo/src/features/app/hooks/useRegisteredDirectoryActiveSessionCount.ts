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
    const unsubscribeChanged = manager.subscribe({ channel: "control", op: "sessions_active_changed" }, refresh);
    return () => {
      current = false;
      unsubscribeChanged();
    };
  }, [activeScreen, connected, directoryKey, generation, manager]);

  return count;
}
