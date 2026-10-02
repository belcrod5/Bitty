import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { UserInputRequest, UserInputResponse } from "../../codex/userInput";

export function useUserInputRequestController(visibleContextId: string) {
  const [request, setRequest] = useState<UserInputRequest | null>(null);
  const visibleContextIdRef = useRef(visibleContextId);
  visibleContextIdRef.current = visibleContextId;
  const pendingRef = useRef<{
    request: UserInputRequest;
    contextId: string;
    resolve: (response: UserInputResponse | null) => void;
  } | null>(null);

  const decide = useCallback((response: UserInputResponse | null) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setRequest(null);
    pending?.resolve(AppState.currentState === "active" &&
      pending.contextId === visibleContextIdRef.current ? response : null);
  }, []);

  const ask = useCallback((next: UserInputRequest, contextId = next.threadId) => {
    if (!contextId || contextId !== visibleContextIdRef.current || AppState.currentState !== "active" ||
      Date.now() >= next.startedAtMs + 60_000 || pendingRef.current) return Promise.resolve(null);
    return new Promise<UserInputResponse | null>((resolve) => {
      pendingRef.current = { request: next, contextId, resolve };
      setRequest(next);
    });
  }, []);

  const resolved = useCallback((next: UserInputRequest) => {
    if (pendingRef.current?.request.requestId === next.requestId) decide(null);
  }, [decide]);

  useEffect(() => {
    if (pendingRef.current && pendingRef.current.contextId !== visibleContextId) decide(null);
  }, [visibleContextId, decide]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") decide(null);
    });
    return () => {
      subscription.remove();
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, [decide]);

  return { request, ask, resolved, decide };
}
