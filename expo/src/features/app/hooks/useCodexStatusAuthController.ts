import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AppScreen, CodexAuthProfileEntry, CodexAuthProfilesSnapshot, CodexCliStatusLimitLine, CodexCliStatusSnapshot } from "../types/appTypes";

type RefreshCodexCliStatusOptions = {
  force?: boolean;
  source?: "manual" | "auto" | "resume" | "initial" | "slash";
};

type UseCodexStatusAuthControllerArgs = {
  activeScreen: AppScreen;
  appStateRef: MutableRefObject<string>;
  auxServerBaseUrl: () => string;
  runnerToken: string;
  codexCliStatusMinRefreshGapMs: number;
  codexCliStatusLastFetchedAtMsRef: MutableRefObject<number>;
  codexCliStatusLastAttemptAtMsRef: MutableRefObject<number>;
  codexCliStatusRefreshInFlightRef: MutableRefObject<boolean>;
  codexAuthProfilesRefreshInFlightRef: MutableRefObject<boolean>;
  codexAuthProfilesSnapshot: CodexAuthProfilesSnapshot | null;
  setCodexCliStatusSnapshot: Dispatch<SetStateAction<CodexCliStatusSnapshot | null>>;
  setCodexCliStatusFetchedAtMs: Dispatch<SetStateAction<number>>;
  setCodexCliStatusLoading: Dispatch<SetStateAction<boolean>>;
  setCodexAuthProfilesSnapshot: Dispatch<SetStateAction<CodexAuthProfilesSnapshot | null>>;
  setCodexAuthProfilesLoading: Dispatch<SetStateAction<boolean>>;
  setCodexAuthSwitching: Dispatch<SetStateAction<boolean>>;
  setCodexAuthSwitchError: Dispatch<SetStateAction<string>>;
  onAuthSwitchStarted: () => void;
};

function parseCodexCliStatusSnapshot(data: unknown): CodexCliStatusSnapshot | null {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const statusText = String(record.statusText || "").trim();
  if (!statusText) return null;
  const rawLimitLines = Array.isArray(record.limitLines) ? record.limitLines : [];
  const limitLines = rawLimitLines
    .map((item: unknown): CodexCliStatusLimitLine | null => {
      if (!item || typeof item !== "object") return null;
      const line = item as Record<string, unknown>;
      const section = String(line.section || "").trim() || "default";
      const label = String(line.label || "").trim();
      const value = String(line.value || "").trim();
      if (!label || !value) return null;
      return { section, label, value };
    })
    .filter((item: CodexCliStatusLimitLine | null): item is CodexCliStatusLimitLine => Boolean(item));
  return {
    statusText,
    limitLines,
    fetchedAt: String(record.fetchedAt || new Date().toISOString()),
  };
}

function parseCodexAuthProfilesSnapshot(data: unknown, fallbackAuthId = ""): CodexAuthProfilesSnapshot {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const currentAuthId = String(record.currentAuthId || fallbackAuthId).trim();
  const rawProfiles = Array.isArray(record.profiles) ? record.profiles : [];
  const profiles = rawProfiles
    .map((item: unknown): CodexAuthProfileEntry | null => {
      if (!item || typeof item !== "object") return null;
      const profile = item as Record<string, unknown>;
      const authId = String(profile.authId || "").trim();
      const fileName = String(profile.fileName || "").trim();
      if (!authId || !fileName) return null;
      return {
        authId,
        fileName,
        isCurrent: Boolean(profile.isCurrent),
      };
    })
    .filter((item: CodexAuthProfileEntry | null): item is CodexAuthProfileEntry => Boolean(item));
  return {
    currentAuthId,
    profiles,
    fetchedAt: String(record.fetchedAt || new Date().toISOString()),
  };
}

export function useCodexStatusAuthController({
  activeScreen,
  appStateRef,
  auxServerBaseUrl,
  runnerToken,
  codexCliStatusMinRefreshGapMs,
  codexCliStatusLastFetchedAtMsRef,
  codexCliStatusLastAttemptAtMsRef,
  codexCliStatusRefreshInFlightRef,
  codexAuthProfilesRefreshInFlightRef,
  codexAuthProfilesSnapshot,
  setCodexCliStatusSnapshot,
  setCodexCliStatusFetchedAtMs,
  setCodexCliStatusLoading,
  setCodexAuthProfilesSnapshot,
  setCodexAuthProfilesLoading,
  setCodexAuthSwitching,
  setCodexAuthSwitchError,
  onAuthSwitchStarted,
}: UseCodexStatusAuthControllerArgs) {
  const isCodexStatusScreenActive = activeScreen === "mini_board";

  const applyCodexCliStatusSnapshot = useCallback((snapshot: CodexCliStatusSnapshot) => {
    const parsedAt = Date.parse(snapshot.fetchedAt);
    const fetchedAtMs = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    codexCliStatusLastFetchedAtMsRef.current = fetchedAtMs;
    setCodexCliStatusSnapshot(snapshot);
    setCodexCliStatusFetchedAtMs(fetchedAtMs);
  }, [codexCliStatusLastFetchedAtMsRef, setCodexCliStatusFetchedAtMs, setCodexCliStatusSnapshot]);

  const fetchRunnerCodexCliStatusForSlash = useCallback(async (): Promise<CodexCliStatusSnapshot | null> => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) return null;
    try {
      const url = new URL(`${targetLlmUrl}/codex-cli/status`);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return parseCodexCliStatusSnapshot(data);
    } catch {
      return null;
    }
  }, [auxServerBaseUrl, runnerToken]);

  const refreshCodexCliStatusForWidget = useCallback(async (options?: RefreshCodexCliStatusOptions) => {
    if (!isCodexStatusScreenActive) return;
    if (appStateRef.current !== "active") return;
    const force = Boolean(options?.force);
    const now = Date.now();
    if (!force && codexCliStatusLastAttemptAtMsRef.current > 0) {
      const elapsedMs = Math.max(0, now - codexCliStatusLastAttemptAtMsRef.current);
      if (elapsedMs < codexCliStatusMinRefreshGapMs) return;
    }
    if (codexCliStatusRefreshInFlightRef.current) return;
    codexCliStatusRefreshInFlightRef.current = true;
    codexCliStatusLastAttemptAtMsRef.current = now;
    setCodexCliStatusLoading(true);
    try {
      const snapshot = await fetchRunnerCodexCliStatusForSlash();
      if (snapshot?.statusText) {
        applyCodexCliStatusSnapshot(snapshot);
      }
    } finally {
      codexCliStatusRefreshInFlightRef.current = false;
      setCodexCliStatusLoading(false);
    }
  }, [
    appStateRef,
    applyCodexCliStatusSnapshot,
    codexCliStatusLastAttemptAtMsRef,
    codexCliStatusMinRefreshGapMs,
    codexCliStatusRefreshInFlightRef,
    fetchRunnerCodexCliStatusForSlash,
    isCodexStatusScreenActive,
    setCodexCliStatusLoading,
  ]);

  const fetchRunnerCodexAuthProfiles = useCallback(async (): Promise<CodexAuthProfilesSnapshot | null> => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) return null;
    try {
      const url = new URL(`${targetLlmUrl}/codex-auth/profiles`);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return parseCodexAuthProfilesSnapshot(data);
    } catch {
      return null;
    }
  }, [auxServerBaseUrl, runnerToken]);

  const applyCodexAuthProfilesSnapshot = useCallback((snapshot: CodexAuthProfilesSnapshot) => {
    setCodexAuthProfilesSnapshot(snapshot);
    setCodexAuthSwitchError("");
  }, [setCodexAuthProfilesSnapshot, setCodexAuthSwitchError]);

  const refreshCodexAuthProfiles = useCallback(async (options?: { force?: boolean }) => {
    if (!isCodexStatusScreenActive) return;
    if (!options?.force && codexAuthProfilesSnapshot) return;
    if (codexAuthProfilesRefreshInFlightRef.current) return;
    codexAuthProfilesRefreshInFlightRef.current = true;
    setCodexAuthProfilesLoading(true);
    try {
      const snapshot = await fetchRunnerCodexAuthProfiles();
      if (snapshot) {
        applyCodexAuthProfilesSnapshot(snapshot);
      }
    } finally {
      codexAuthProfilesRefreshInFlightRef.current = false;
      setCodexAuthProfilesLoading(false);
    }
  }, [
    applyCodexAuthProfilesSnapshot,
    codexAuthProfilesRefreshInFlightRef,
    codexAuthProfilesSnapshot,
    fetchRunnerCodexAuthProfiles,
    isCodexStatusScreenActive,
    setCodexAuthProfilesLoading,
  ]);

  const switchCodexAuthProfile = useCallback(async (authIdRaw: string) => {
    const authId = String(authIdRaw || "").trim();
    if (!authId) {
      setCodexAuthSwitchError("authId が空です。");
      return false;
    }
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      setCodexAuthSwitchError("Runner URL または token が未設定です。");
      return false;
    }
    setCodexAuthSwitching(true);
    setCodexAuthSwitchError("");
    try {
      const url = new URL(`${targetLlmUrl}/codex-auth/switch`);
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ authId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(data?.message || data?.error || `HTTP ${res.status}`).trim();
        setCodexAuthSwitchError(message || "切替に失敗しました。");
        return false;
      }
      applyCodexAuthProfilesSnapshot(parseCodexAuthProfilesSnapshot(data, authId));
      await refreshCodexCliStatusForWidget({
        force: true,
        source: "manual",
      });
      onAuthSwitchStarted();
      return true;
    } catch (err) {
      setCodexAuthSwitchError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setCodexAuthSwitching(false);
    }
  }, [
    applyCodexAuthProfilesSnapshot,
    auxServerBaseUrl,
    onAuthSwitchStarted,
    refreshCodexCliStatusForWidget,
    runnerToken,
    setCodexAuthSwitchError,
    setCodexAuthSwitching,
  ]);

  return {
    fetchRunnerCodexCliStatusForSlash,
    applyCodexCliStatusSnapshot,
    refreshCodexCliStatusForWidget,
    refreshCodexAuthProfiles,
    switchCodexAuthProfile,
  };
}
