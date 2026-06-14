import {
  createRunnerWsClient,
  type RunnerWsClient,
  type RunnerWsClientOptions,
  type RunnerWsUnsubscribe,
} from "./client";
import type {
  RunnerWsConnectionSnapshot,
  RunnerWsMessage,
  RunnerWsMessageFilter,
} from "./types";

type SharedRunnerWsEntry = {
  key: string;
  client: RunnerWsClient;
  refCount: number;
  snapshot: RunnerWsConnectionSnapshot;
  snapshotListeners: Set<(snapshot: RunnerWsConnectionSnapshot) => void>;
  openListeners: Set<() => void>;
  closeListeners: Set<(event: WebSocketCloseEvent) => void>;
  errorListeners: Set<(event: Event) => void>;
  invalidMessageListeners: Set<(raw: string) => void>;
};

const sharedEntries = new Map<string, SharedRunnerWsEntry>();

function buildSharedRunnerWsKey(options: RunnerWsClientOptions) {
  const url = String(options.url || "").trim();
  const token = String(options.token || "").trim();
  const reconnect = options.reconnect === true ? "1" : "0";
  const reconnectDelayMs = Number.isFinite(Number(options.reconnectDelayMs))
    ? Math.max(250, Math.floor(Number(options.reconnectDelayMs)))
    : 1000;
  const reconnectMaxDelayMs = Number.isFinite(Number(options.reconnectMaxDelayMs))
    ? Math.max(reconnectDelayMs, Math.floor(Number(options.reconnectMaxDelayMs)))
    : 5000;
  const reconnectJitterRatio = Number.isFinite(Number(options.reconnectJitterRatio))
    ? Math.min(0.5, Math.max(0, Number(options.reconnectJitterRatio)))
    : 0.2;
  return `${url}::${token}::${reconnect}::${reconnectDelayMs}::${reconnectMaxDelayMs}::${reconnectJitterRatio}`;
}

function emitSafely<T>(listeners: Set<(value: T) => void>, value: T) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(value);
    } catch {}
  }
}

function emitVoidSafely(listeners: Set<() => void>) {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {}
  }
}

function createSharedEntry(options: RunnerWsClientOptions, key: string): SharedRunnerWsEntry {
  const snapshotListeners = new Set<(snapshot: RunnerWsConnectionSnapshot) => void>();
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<(event: WebSocketCloseEvent) => void>();
  const errorListeners = new Set<(event: Event) => void>();
  const invalidMessageListeners = new Set<(raw: string) => void>();

  const client = createRunnerWsClient({
    ...options,
    onSnapshot: (snapshot) => {
      entry.snapshot = snapshot;
      emitSafely(snapshotListeners, snapshot);
    },
    onOpen: () => {
      emitVoidSafely(openListeners);
    },
    onClose: (event) => {
      emitSafely(closeListeners, event);
    },
    onError: (event) => {
      emitSafely(errorListeners, event);
    },
    onInvalidMessage: (raw) => {
      emitSafely(invalidMessageListeners, raw);
    },
  });

  const entry: SharedRunnerWsEntry = {
    key,
    client,
    refCount: 0,
    snapshot: client.getSnapshot(),
    snapshotListeners,
    openListeners,
    closeListeners,
    errorListeners,
    invalidMessageListeners,
  };
  return entry;
}

export function acquireSharedRunnerWsClient(options: RunnerWsClientOptions): RunnerWsClient {
  const key = buildSharedRunnerWsKey(options);
  let entry: SharedRunnerWsEntry | null = sharedEntries.get(key) || null;
  if (!entry) {
    entry = createSharedEntry(options, key);
    sharedEntries.set(key, entry);
  }
  entry.refCount += 1;

  const snapshotListener = options.onSnapshot;
  const openListener = options.onOpen;
  const closeListener = options.onClose;
  const errorListener = options.onError;
  const invalidMessageListener = options.onInvalidMessage;

  if (snapshotListener) {
    entry.snapshotListeners.add(snapshotListener);
    try {
      snapshotListener(entry.snapshot);
    } catch {}
  }
  if (openListener) entry.openListeners.add(openListener);
  if (closeListener) entry.closeListeners.add(closeListener);
  if (errorListener) entry.errorListeners.add(errorListener);
  if (invalidMessageListener) entry.invalidMessageListeners.add(invalidMessageListener);

  let closed = false;
  return {
    send(message: RunnerWsMessage) {
      if (!entry) return false;
      return entry.client.send(message);
    },
    subscribe(
      filter: RunnerWsMessageFilter,
      handler: (message: RunnerWsMessage) => void
    ): RunnerWsUnsubscribe {
      if (!entry) return () => {};
      return entry.client.subscribe(filter, handler);
    },
    getSnapshot() {
      if (!entry) {
        return {
          url: String(options.url || "").trim(),
          readyState: typeof WebSocket !== "undefined" ? WebSocket.CLOSED : 3,
          connected: false,
          reconnectCount: 0,
        };
      }
      return entry.snapshot;
    },
    close() {
      if (closed) return;
      closed = true;
      if (!entry) return;

      if (snapshotListener) entry.snapshotListeners.delete(snapshotListener);
      if (openListener) entry.openListeners.delete(openListener);
      if (closeListener) entry.closeListeners.delete(closeListener);
      if (errorListener) entry.errorListeners.delete(errorListener);
      if (invalidMessageListener) entry.invalidMessageListeners.delete(invalidMessageListener);

      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount > 0) {
        entry = null;
        return;
      }

      sharedEntries.delete(key);
      const client = entry.client;
      entry = null;
      client.close();
    },
  };
}
