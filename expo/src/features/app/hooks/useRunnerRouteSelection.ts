import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Network from "expo-network";

const ROUTE_RECHECK_DEBOUNCE_MS = 500;
const NETWORK_STABILIZE_RECHECK_DELAYS_MS = [500, 2000, 5000];
const LOCAL_HEALTH_TIMEOUT_MS = 2500;

type RunnerRouteSelectionArgs = {
  enabled: boolean;
  localRunnerUrl: string;
  localRunnerWsUrl: string;
  cloudflareRunnerUrl: string;
  cloudflareRunnerWsUrl: string;
  runnerToken: string;
  runnerUrl: string;
  codexWsUrl: string;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
  setCodexWsUrl: Dispatch<SetStateAction<string>>;
};

export type RunnerRouteSelectionState = {
  selectedRoute: "local" | "cloudflare" | "unknown";
  checkedAtMs: number;
};

export type RunnerRouteSelectionResult = RunnerRouteSelectionState & {
  requestRouteRecheck: () => void;
};

type RunnerRouteTarget = {
  runnerUrl: string;
  runnerWsUrl: string;
};

function trimTrailingSlash(value: unknown) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildHealthUrl(runnerUrl: string) {
  const normalized = trimTrailingSlash(runnerUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function probeRunnerHealth(runnerUrl: string, runnerToken: string) {
  const healthUrl = buildHealthUrl(runnerUrl);
  const token = String(runnerToken || "").trim();
  if (!healthUrl || !token) return false;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), LOCAL_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      ...(controller ? { signal: controller.signal } : {}),
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function applyRouteTarget(
  target: RunnerRouteTarget,
  current: RunnerRouteTarget,
  setRunnerUrl: Dispatch<SetStateAction<string>>,
  setCodexWsUrl: Dispatch<SetStateAction<string>>
) {
  if (!target.runnerUrl || !target.runnerWsUrl) return;
  if (target.runnerUrl === current.runnerUrl && target.runnerWsUrl === current.runnerWsUrl) return;
  setRunnerUrl(target.runnerUrl);
  setCodexWsUrl(target.runnerWsUrl);
}

export function useRunnerRouteSelection({
  enabled,
  localRunnerUrl,
  localRunnerWsUrl,
  cloudflareRunnerUrl,
  cloudflareRunnerWsUrl,
  runnerToken,
  runnerUrl,
  codexWsUrl,
  setRunnerUrl,
  setCodexWsUrl,
}: RunnerRouteSelectionArgs) {
  const latestRef = useRef({
    enabled,
    localRunnerUrl: trimTrailingSlash(localRunnerUrl),
    localRunnerWsUrl: String(localRunnerWsUrl || "").trim(),
    cloudflareRunnerUrl: trimTrailingSlash(cloudflareRunnerUrl),
    cloudflareRunnerWsUrl: String(cloudflareRunnerWsUrl || "").trim(),
    runnerToken: String(runnerToken || "").trim(),
    runnerUrl: trimTrailingSlash(runnerUrl),
    codexWsUrl: String(codexWsUrl || "").trim(),
  });
  const recheckTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scheduleGenerationRef = useRef(0);
  const probeSeqRef = useRef(0);
  const previousAppStateRef = useRef<AppStateStatus>(AppState.currentState);
  const scheduleRouteSelectionRef = useRef<(delaysMs: readonly number[]) => void>(() => undefined);
  const [selectionState, setSelectionState] = useState<RunnerRouteSelectionState>({
    selectedRoute: "unknown",
    checkedAtMs: 0,
  });
  const requestRouteRecheck = useCallback(() => {
    scheduleRouteSelectionRef.current(NETWORK_STABILIZE_RECHECK_DELAYS_MS);
  }, []);

  useEffect(() => {
    latestRef.current = {
      enabled,
      localRunnerUrl: trimTrailingSlash(localRunnerUrl),
      localRunnerWsUrl: String(localRunnerWsUrl || "").trim(),
      cloudflareRunnerUrl: trimTrailingSlash(cloudflareRunnerUrl),
      cloudflareRunnerWsUrl: String(cloudflareRunnerWsUrl || "").trim(),
      runnerToken: String(runnerToken || "").trim(),
      runnerUrl: trimTrailingSlash(runnerUrl),
      codexWsUrl: String(codexWsUrl || "").trim(),
    };
  }, [
    cloudflareRunnerUrl,
    cloudflareRunnerWsUrl,
    codexWsUrl,
    enabled,
    localRunnerUrl,
    localRunnerWsUrl,
    runnerToken,
    runnerUrl,
  ]);

  useEffect(() => {
    function clearScheduledRechecks() {
      for (const timer of recheckTimersRef.current) {
        clearTimeout(timer);
      }
      recheckTimersRef.current = [];
    }

    async function reselectRoute(scheduleGeneration: number) {
      const probeSeq = ++probeSeqRef.current;
      const latest = latestRef.current;
      if (
        !latest.enabled ||
        !latest.localRunnerUrl ||
        !latest.localRunnerWsUrl ||
        !latest.cloudflareRunnerUrl ||
        !latest.cloudflareRunnerWsUrl ||
        !latest.runnerToken
      ) {
        return;
      }

      const localReachable = await probeRunnerHealth(latest.localRunnerUrl, latest.runnerToken);
      if (scheduleGeneration !== scheduleGenerationRef.current || probeSeq !== probeSeqRef.current) return;

      const current = latestRef.current;
      const selectedRoute = localReachable ? "local" : "cloudflare";
      setSelectionState({
        selectedRoute,
        checkedAtMs: Date.now(),
      });
      applyRouteTarget(
        localReachable
          ? { runnerUrl: current.localRunnerUrl, runnerWsUrl: current.localRunnerWsUrl }
          : { runnerUrl: current.cloudflareRunnerUrl, runnerWsUrl: current.cloudflareRunnerWsUrl },
        { runnerUrl: current.runnerUrl, runnerWsUrl: current.codexWsUrl },
        setRunnerUrl,
        setCodexWsUrl
      );
      if (localReachable) {
        clearScheduledRechecks();
      }
    }

    function scheduleRouteSelection(delaysMs: readonly number[]) {
      clearScheduledRechecks();
      const scheduleGeneration = scheduleGenerationRef.current + 1;
      scheduleGenerationRef.current = scheduleGeneration;
      probeSeqRef.current += 1;
      recheckTimersRef.current = delaysMs.map((delayMs) => {
        const timeout = setTimeout(() => {
          recheckTimersRef.current = recheckTimersRef.current.filter((timer) => timer !== timeout);
          void reselectRoute(scheduleGeneration);
        }, delayMs);
        return timeout;
      });
    }

    scheduleRouteSelectionRef.current = scheduleRouteSelection;
    const networkSubscription = Network.addNetworkStateListener(() => {
      scheduleRouteSelection(NETWORK_STABILIZE_RECHECK_DELAYS_MS);
    });
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      const previousState = previousAppStateRef.current;
      previousAppStateRef.current = nextState;
      if (nextState !== "active") return;
      if (previousState !== "background" && previousState !== "inactive") return;
      scheduleRouteSelection([ROUTE_RECHECK_DEBOUNCE_MS]);
    });

    return () => {
      clearScheduledRechecks();
      scheduleGenerationRef.current += 1;
      probeSeqRef.current += 1;
      scheduleRouteSelectionRef.current = () => undefined;
      networkSubscription.remove();
      appStateSubscription.remove();
    };
  }, [setCodexWsUrl, setRunnerUrl]);

  useEffect(() => {
    if (!enabled || !localRunnerUrl || !localRunnerWsUrl || !cloudflareRunnerUrl || !cloudflareRunnerWsUrl || !runnerToken) return;
    scheduleRouteSelectionRef.current([0]);
  }, [
    cloudflareRunnerUrl,
    cloudflareRunnerWsUrl,
    enabled,
    localRunnerUrl,
    localRunnerWsUrl,
    runnerToken,
  ]);

  return {
    ...selectionState,
    requestRouteRecheck,
  } satisfies RunnerRouteSelectionResult;
}
