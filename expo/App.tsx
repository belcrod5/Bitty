import { useCallback, useEffect, useRef } from "react";
import * as SplashScreen from "expo-splash-screen";

import AppRoot from "./src/features/app/AppRoot";
import { SPLASH_FAIL_OPEN_MS } from "./src/features/app/theme/themeSplashTiming";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const SPLASH_HIDE_RETRY_MS = 250;

export default function App() {
  const mountedRef = useRef(true);
  const hideStateRef = useRef({
    hidden: false,
    pending: false,
    retryRequested: false,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
  });
  const hideSplashScreen = useCallback((retryOnFailure = true) => {
    const state = hideStateRef.current;
    if (state.hidden) return;
    if (state.pending) {
      state.retryRequested ||= retryOnFailure;
      return;
    }
    state.pending = true;
    state.retryRequested = false;
    void SplashScreen.hideAsync()
      .then(() => {
        if (!mountedRef.current) return;
        state.pending = false;
        state.hidden = true;
        state.retryRequested = false;
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
      })
      .catch(() => {
        if (!mountedRef.current) return;
        state.pending = false;
        const shouldRetry = retryOnFailure || state.retryRequested;
        state.retryRequested = false;
        if (!shouldRetry || state.retryTimer) return;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          hideSplashScreen(false);
        }, SPLASH_HIDE_RETRY_MS);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const fallback = setTimeout(() => hideSplashScreen(true), SPLASH_FAIL_OPEN_MS);
    return () => {
      mountedRef.current = false;
      clearTimeout(fallback);
      const retryTimer = hideStateRef.current.retryTimer;
      if (retryTimer) clearTimeout(retryTimer);
      hideStateRef.current.retryTimer = null;
    };
  }, [hideSplashScreen]);

  return <AppRoot onReady={hideSplashScreen} />;
}
