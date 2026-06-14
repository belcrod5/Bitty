import { useEffect, useRef, type MutableRefObject } from "react";
import { AppState } from "react-native";
import type { AppScreen } from "../types/appTypes";

type UseCodexStatusRefreshEffectsArgs = {
  activeScreen: AppScreen;
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
  activeScreen,
  runnerUrl,
  runnerToken,
  appStateRef,
  codexCliStatusLastAttemptAtMsRef,
  codexCliStatusAutoRefreshMs,
  refreshCodexCliStatusForWidget,
  refreshCodexAuthProfiles,
}: UseCodexStatusRefreshEffectsArgs) {
  const codexAuthRefreshKeyRef = useRef("");
  const isCodexStatusScreenActive = activeScreen === "mini_board";

  useEffect(() => {
    if (!isCodexStatusScreenActive) return;
    if (appStateRef.current !== "active") return;
    if (codexCliStatusLastAttemptAtMsRef.current > 0) return;
    void refreshCodexCliStatusForWidget({
      force: true,
      source: "initial",
    });
  }, [appStateRef, codexCliStatusLastAttemptAtMsRef, isCodexStatusScreenActive, refreshCodexCliStatusForWidget, runnerToken, runnerUrl]);

  useEffect(() => {
    if (!isCodexStatusScreenActive) return;
    if (appStateRef.current !== "active") return;
    const nextRefreshKey = `${runnerUrl.trim()}::${runnerToken.trim()}`;
    const shouldForceRefresh = codexAuthRefreshKeyRef.current !== nextRefreshKey;
    codexAuthRefreshKeyRef.current = nextRefreshKey;
    void refreshCodexAuthProfiles({
      force: shouldForceRefresh,
    });
  }, [appStateRef, isCodexStatusScreenActive, refreshCodexAuthProfiles, runnerToken, runnerUrl]);

  useEffect(() => {
    if (!isCodexStatusScreenActive) return;
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
    isCodexStatusScreenActive,
    refreshCodexCliStatusForWidget,
    runnerToken,
    runnerUrl,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      if (!isCodexStatusScreenActive) return;
      const elapsedMs = codexCliStatusLastAttemptAtMsRef.current > 0
        ? Math.max(0, Date.now() - codexCliStatusLastAttemptAtMsRef.current)
        : codexCliStatusAutoRefreshMs;
      if (elapsedMs < codexCliStatusAutoRefreshMs) return;
      void refreshCodexCliStatusForWidget({
        force: true,
        source: "resume",
      });
    });
    return () => {
      sub.remove();
    };
  }, [
    codexCliStatusAutoRefreshMs,
    codexCliStatusLastAttemptAtMsRef,
    isCodexStatusScreenActive,
    refreshCodexCliStatusForWidget,
    runnerToken,
    runnerUrl,
  ]);
}
