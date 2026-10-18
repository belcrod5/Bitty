import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useChatDiagnostics } from "../contexts/ChatDiagnosticsContext";

const native = Platform.OS === "ios"
  ? requireOptionalNativeModule<{ activateSource: (runnerUrl: string, runnerToken: string) => Promise<void>; refreshSnapshot: (runnerUrl: string, runnerToken: string) => Promise<boolean> }>("BittyWidgets") : null;
export function WidgetSnapshotPublisher({ ready }: { ready: boolean }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const { codexAuthSwitching, codexCliStatusFetchedAtMs } = useChatDiagnostics();
  const manager = useRunnerWebSocketManager();
  const { connected, generation, appState } = useRunnerWebSocketSnapshot();

  useEffect(() => {
    if (native && ready && appState === "active" && AppState.currentState === "active") {
      void native.activateSource(runnerUrl, runnerToken).catch(() => undefined);
    }
  }, [appState, ready, runnerUrl, runnerToken]);

  useEffect(() => {
    if (!native || !ready || !connected || appState !== "active" || codexAuthSwitching) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (AppState.currentState === "active") void native.refreshSnapshot(runnerUrl, runnerToken).catch(() => undefined);
      }, 500);
    };
    refresh();
    const subscriptions = [
      manager.subscribe({ channel: "agent", op: "voice.unread.changed" }, refresh),
      manager.subscribe({ channel: "agent", op: "voice.task-checklist.changed" }, refresh),
      manager.subscribe({ channel: "control", op: "sessions_active_changed" }, refresh),
      manager.subscribe({ channel: "control", op: "codex_usage_updated" }, refresh),
    ];
    return () => { clearTimeout(timer); subscriptions.forEach((unsubscribe) => unsubscribe()); };
  }, [appState, ready, connected, generation, manager, runnerUrl, runnerToken, codexAuthSwitching, codexCliStatusFetchedAtMs]);

  return null;
}
