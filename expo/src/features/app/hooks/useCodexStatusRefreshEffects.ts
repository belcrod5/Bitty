import { useEffect, useRef, type MutableRefObject } from "react";
import { AppState } from "react-native";

type UseCodexStatusRefreshEffectsArgs = {
  runnerUrl: string;
  runnerToken: string;
  appStateRef: MutableRefObject<string>;
  codexCliStatusLastAttemptAtMsRef: MutableRefObject<number>;
  codexCliStatusAutoRefreshMs: number;
  refreshCodexCliStatusForWidget: (options?: {
    force?: boolean;
    source?: "manual" | "auto" | "resume" | "initial" | "slash";
  }) => void | Promise<void>;
  refreshCodexAuthProfiles: (options?: { force?: boolean }) => void | Promise<void>;
};

export function useCodexStatusRefreshEffects({
  runnerUrl,
  runnerToken,
  appStateRef,
  codexCliStatusLastAttemptAtMsRef,
  codexCliStatusAutoRefreshMs,
  refreshCodexCliStatusForWidget,
  refreshCodexAuthProfiles,
}: UseCodexStatusRefreshEffectsArgs) {
  const codexAuthRefreshKeyRef = useRef("");

  useEffect(() => {
    if (appStateRef.current !== "active") return;
    if (codexCliStatusLastAttemptAtMsRef.current > 0) return;
    void refreshCodexCliStatusForWidget({
      force: true,
      source: "initial",
    });
  }, [appStateRef, codexCliStatusLastAttemptAtMsRef, refreshCodexCliStatusForWidget, runnerToken, runnerUrl]);

  useEffect(() => {
    if (appStateRef.current !== "active") return;
    const nextRefreshKey = `${runnerUrl.trim()}::${runnerToken.trim()}`;
    const shouldForceRefresh = codexAuthRefreshKeyRef.current !== nextRefreshKey;
    codexAuthRefreshKeyRef.current = nextRefreshKey;
    void refreshCodexAuthProfiles({
      force: shouldForceRefresh,
    });
  }, [appStateRef, refreshCodexAuthProfiles, runnerToken, runnerUrl]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (appStateRef.current !== "active") return;
      const elapsedMs = codexCliStatusLastAttemptAtMsRef.current > 0
        ? Math.max(0, Date.now() - codexCliStatusLastAttemptAtMsRef.current)
        : codexCliStatusAutoRefreshMs;
      if (elapsedMs < codexCliStatusAutoRefreshMs) return;
      void refreshCodexCliStatusForWidget({
        source: "auto",
      });
    }, 30 * 1000);
    return () => {
      clearInterval(timer);
    };
  }, [
    appStateRef,
    codexCliStatusAutoRefreshMs,
    codexCliStatusLastAttemptAtMsRef,
    refreshCodexCliStatusForWidget,
    runnerToken,
    runnerUrl,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      void refreshCodexCliStatusForWidget({
        source: "resume",
      });
    });
    return () => {
      sub.remove();
    };
  }, [
    refreshCodexCliStatusForWidget,
    runnerToken,
    runnerUrl,
  ]);
}
