import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type RunnerWsClient,
  type RunnerWsUnsubscribe,
} from "./client";
import { acquireSharedRunnerWsClient } from "./manager";
import { isRunnerWsUrl } from "./llmAdapter";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "./types";

export type RunnerWsContextValue = {
  enabled: boolean;
  url: string;
  snapshot: RunnerWsConnectionSnapshot;
  send: (message: RunnerWsMessage) => boolean;
  subscribe: (
    filter: RunnerWsMessageFilter,
    handler: (message: RunnerWsMessage) => void
  ) => RunnerWsUnsubscribe;
  getSnapshot: () => RunnerWsConnectionSnapshot;
};

type RunnerWsProviderProps = {
  url: string;
  token?: string;
  enabled?: boolean;
  children: ReactNode;
};

const disconnectedSnapshot: RunnerWsConnectionSnapshot = {
  url: "",
  readyState: typeof WebSocket !== "undefined" ? WebSocket.CLOSED : 3,
  connected: false,
  reconnectCount: 0,
  sentCount: 0,
  receivedCount: 0,
  sendErrorCount: 0,
  closeCount: 0,
  errorCount: 0,
  missedPingCount: 0,
  consecutiveMissedPingCount: 0,
};

const RunnerWsContext = createContext<RunnerWsContextValue | null>(null);

function normalizeRunnerWsUrl(rawUrl: string, rawToken: string) {
  const url = String(rawUrl || "").trim();
  const token = String(rawToken || "").trim();
  if (!url || !token) return url;
  try {
    const parsed = new URL(url);
    if (!String(parsed.searchParams.get("token") || "").trim()) {
      parsed.searchParams.set("token", token);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function RunnerWsProvider({
  url,
  token = "",
  enabled = true,
  children,
}: RunnerWsProviderProps) {
  const normalizedUrl = useMemo(
    () => normalizeRunnerWsUrl(url, token),
    [url, token]
  );
  const shouldConnect = enabled && isRunnerWsUrl(normalizedUrl);
  const clientRef = useRef<RunnerWsClient | null>(null);
  const pendingSubscribersRef = useRef(new Set<{
    filter: RunnerWsMessageFilter;
    handler: (message: RunnerWsMessage) => void;
    unsubscribe: RunnerWsUnsubscribe | null;
  }>());
  const [snapshot, setSnapshot] = useState<RunnerWsConnectionSnapshot>({
    ...disconnectedSnapshot,
    url: normalizedUrl,
  });

  const refreshSnapshot = useCallback(() => {
    const client = clientRef.current;
    setSnapshot(client ? client.getSnapshot() : { ...disconnectedSnapshot, url: normalizedUrl });
  }, [normalizedUrl]);

  useEffect(() => {
    for (const subscriber of pendingSubscribersRef.current) {
      subscriber.unsubscribe?.();
      subscriber.unsubscribe = null;
    }

    clientRef.current?.close();
    clientRef.current = null;

    if (!shouldConnect || !normalizedUrl) {
      setSnapshot({ ...disconnectedSnapshot, url: normalizedUrl });
      return;
    }

    const client = acquireSharedRunnerWsClient({
      url: normalizedUrl,
      token,
      reconnect: true,
      reconnectDelayMs: 1000,
      reconnectMaxDelayMs: 5000,
      onSnapshot: setSnapshot,
    });
    clientRef.current = client;
    setSnapshot(client.getSnapshot());

    for (const subscriber of pendingSubscribersRef.current) {
      subscriber.unsubscribe = client.subscribe(subscriber.filter, subscriber.handler);
    }

    return () => {
      for (const subscriber of pendingSubscribersRef.current) {
        subscriber.unsubscribe?.();
        subscriber.unsubscribe = null;
      }
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      client.close();
    };
  }, [normalizedUrl, refreshSnapshot, shouldConnect, token]);

  const send = useCallback((message: RunnerWsMessage) => {
    const sent = clientRef.current?.send(message) ?? false;
    if (!sent) refreshSnapshot();
    return sent;
  }, [refreshSnapshot]);

  const subscribe = useCallback((
    filter: RunnerWsMessageFilter,
    handler: (message: RunnerWsMessage) => void
  ) => {
    const subscriber = {
      filter,
      handler,
      unsubscribe: clientRef.current?.subscribe(filter, handler) ?? null,
    };
    pendingSubscribersRef.current.add(subscriber);
    return () => {
      pendingSubscribersRef.current.delete(subscriber);
      subscriber.unsubscribe?.();
      subscriber.unsubscribe = null;
    };
  }, []);

  const getSnapshot = useCallback(() => {
    return clientRef.current?.getSnapshot() ?? { ...disconnectedSnapshot, url: normalizedUrl };
  }, [normalizedUrl]);

  const value = useMemo<RunnerWsContextValue>(() => ({
    enabled: shouldConnect,
    url: normalizedUrl,
    snapshot,
    send,
    subscribe,
    getSnapshot,
  }), [getSnapshot, normalizedUrl, send, shouldConnect, snapshot, subscribe]);

  return <RunnerWsContext.Provider value={value}>{children}</RunnerWsContext.Provider>;
}

export function useRunnerWs() {
  const context = useContext(RunnerWsContext);
  if (!context) {
    throw new Error("useRunnerWs must be used within RunnerWsProvider");
  }
  return context;
}
