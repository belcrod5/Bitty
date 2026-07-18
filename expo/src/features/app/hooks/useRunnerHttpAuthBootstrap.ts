import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

export type RunnerHttpAuth = {
  baseUrl: string;
  token: string;
};

type UseRunnerHttpAuthBootstrapArgs = {
  settingsLoaded: boolean;
  baseUrl: string;
  token: string;
  // One-shot recovery fired on the settingsLoaded transition. Read through a
  // ref because the callback (session-tree refresh) is defined later in the
  // owning component than this hook call.
  onSettingsLoadedOnceRef: MutableRefObject<() => void>;
};

// HTTP counterpart of the runner WebSocket bootstrapReady gate. Runner HTTP
// requests triggered before persisted settings finish loading (e.g. MiniBoard
// effects fired by the registered-directories commit) would otherwise capture
// an empty bearer token in their closures: callers await the barrier, then
// read the live URL/token from a per-render ref.
export function useRunnerHttpAuthBootstrap({
  settingsLoaded,
  baseUrl,
  token,
  onSettingsLoadedOnceRef,
}: UseRunnerHttpAuthBootstrapArgs): () => Promise<RunnerHttpAuth> {
  const [barrier] = useState(() => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  });
  const authRef = useRef<RunnerHttpAuth>({ baseUrl: "", token: "" });
  authRef.current = { baseUrl: baseUrl.trim(), token: token.trim() };
  const recoveredOnSettingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!settingsLoaded) return;
    barrier.resolve();
    if (recoveredOnSettingsLoadedRef.current) return;
    recoveredOnSettingsLoadedRef.current = true;
    onSettingsLoadedOnceRef.current();
  }, [settingsLoaded, barrier, onSettingsLoadedOnceRef]);
  return useCallback(async () => {
    await barrier.promise;
    return authRef.current;
  }, [barrier]);
}
