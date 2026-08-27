import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Network from "../networkState";

const ROUTE_RECHECK_DEBOUNCE_MS = 500;
const NETWORK_STABILIZE_RECHECK_DELAYS_MS = [500, 2000, 5000];
const LOCAL_HEALTH_TIMEOUT_MS = 2500;

type RunnerRouteSelectionArgs = {
  enabled: boolean;
  localRunnerUrl: string;
  cloudflareRunnerUrl: string;
  runnerToken: string;
  runnerUrl: string;
  setRunnerUrl: Dispatch<SetStateAction<string>>;
};

export type RunnerRouteSelectionState = {
  selectedRoute: "local" | "cloudflare" | "unknown";
  checkedAtMs: number;
};

export type RunnerRouteSelectionResult = RunnerRouteSelectionState & {
  requestRouteRecheck: () => void;
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

export function useRunnerRouteSelection({
  enabled,
  localRunnerUrl,
  cloudflareRunnerUrl,
  runnerToken,
  runnerUrl,
  setRunnerUrl,
}: RunnerRouteSelectionArgs) {
  const latestRef = useRef({
    enabled,
    localRunnerUrl: trimTrailingSlash(localRunnerUrl),
    cloudflareRunnerUrl: trimTrailingSlash(cloudflareRunnerUrl),
    runnerToken: String(runnerToken || "").trim(),
    runnerUrl: trimTrailingSlash(runnerUrl),
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
      cloudflareRunnerUrl: trimTrailingSlash(cloudflareRunnerUrl),
      runnerToken: String(runnerToken || "").trim(),
      runnerUrl: trimTrailingSlash(runnerUrl),
    };
  }, [
    cloudflareRunnerUrl,
    enabled,
    localRunnerUrl,
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
        !latest.cloudflareRunnerUrl ||
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
      const targetRunnerUrl = localReachable
        ? current.localRunnerUrl
        : current.cloudflareRunnerUrl;
      if (targetRunnerUrl && targetRunnerUrl !== current.runnerUrl) {
        setRunnerUrl(targetRunnerUrl);
      }
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
  }, [setRunnerUrl]);

  useEffect(() => {
    if (!enabled || !localRunnerUrl || !cloudflareRunnerUrl || !runnerToken) return;
    scheduleRouteSelectionRef.current([0]);
  }, [
    cloudflareRunnerUrl,
    enabled,
    localRunnerUrl,
    runnerToken,
  ]);

  return {
    ...selectionState,
    requestRouteRecheck,
  } satisfies RunnerRouteSelectionResult;
}
