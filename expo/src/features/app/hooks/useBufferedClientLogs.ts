import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";

export type BufferedLogEntrySeed = {
  sessionId: string;
  seq: number;
  at: string;
  event: string;
  payload: Record<string, unknown>;
};

type FlushOptions = {
  maxBatches?: number;
};

type UseBufferedClientLogsOptions<TEntry> = {
  enabled: boolean;
  source: string;
  runnerUrl: string;
  runnerToken: string;
  getBaseUrl: () => string;
  createSessionId: () => string;
  createEntry: (seed: BufferedLogEntrySeed) => TEntry;
  bufferMax: number;
  flushBatchSize: number;
  flushDelayMs: number;
  retryMs: number;
};

function sanitizePayload(raw: Record<string, unknown>) {
  try {
    const jsonRaw = JSON.stringify(raw && typeof raw === "object" ? raw : {});
    return jsonRaw ? (JSON.parse(jsonRaw) as Record<string, unknown>) : {};
  } catch {
    return { note: "payload_unserializable" };
  }
}

export function useBufferedClientLogs<TEntry extends BufferedLogEntrySeed>(
  options: UseBufferedClientLogsOptions<TEntry>
) {
  const {
    enabled,
    source,
    runnerUrl,
    runnerToken,
    getBaseUrl,
    createSessionId,
    createEntry,
    bufferMax,
    flushBatchSize,
    flushDelayMs,
    retryMs,
  } = options;

  const sessionIdRef = useRef(createSessionId());
  const seqRef = useRef(0);
  const bufferRef = useRef<TEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const bufferEvictedCountRef = useRef(0);
  const liveOptionsRef = useRef(options);
  liveOptionsRef.current = options;
  const flushRef = useRef<(flushOptions?: FlushOptions) => Promise<void>>(async () => {});

  const clearFlushTimer = useCallback(() => {
    if (!flushTimerRef.current) return;
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }, []);

  const flush = useCallback(async (flushOptions?: FlushOptions) => {
    if (!enabled || !mountedRef.current) return;
    if (flushInFlightRef.current) return;
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    if (bufferRef.current.length <= 0) return;
    const isCurrent = () => mountedRef.current && liveOptionsRef.current.enabled
      && liveOptionsRef.current.runnerUrl === runnerUrl && liveOptionsRef.current.runnerToken === runnerToken
      && liveOptionsRef.current.source === source;
    flushInFlightRef.current = true;
    clearFlushTimer();
    try {
      const maxBatches = Math.max(1, Math.floor(Number(flushOptions?.maxBatches ?? 12)));
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        if (!isCurrent()) break;
        const batch = bufferRef.current.slice(0, flushBatchSize);
        if (batch.length <= 0) break;
        const res = await fetch(`${getBaseUrl()}/client-logs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${runnerToken.trim()}`,
          },
          body: JSON.stringify({
            source,
            sessionId: sessionIdRef.current,
            device: `${Platform.OS}:${String(Platform.Version)}`,
            events: [{
              ...batch[0],
              payload: {
                ...batch[0].payload,
                clientLogGeneratedThroughSeq: seqRef.current,
                clientLogBufferEvictedCount: bufferEvictedCountRef.current,
              },
            }, ...batch.slice(1)],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        const acknowledged = new Set(batch);
        bufferRef.current = bufferRef.current.filter((entry) => !acknowledged.has(entry));
      }
    } catch {
      clearFlushTimer();
      if (isCurrent()) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          void flushRef.current();
        }, Math.max(0, retryMs));
      }
    } finally {
      flushInFlightRef.current = false;
      if (mountedRef.current && liveOptionsRef.current.enabled && bufferRef.current.length > 0 && !flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          void flushRef.current();
        }, Math.max(0, flushDelayMs));
      }
    }
  }, [
    clearFlushTimer,
    enabled,
    flushBatchSize,
    flushDelayMs,
    getBaseUrl,
    retryMs,
    runnerToken,
    runnerUrl,
    source,
  ]);

  flushRef.current = flush;

  const scheduleFlush = useCallback((delayMs = flushDelayMs) => {
    if (!enabled || !mountedRef.current) return;
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flushRef.current();
    }, Math.max(0, delayMs));
  }, [enabled, flushDelayMs]);

  const enqueue = useCallback((event: string, payload: Record<string, unknown>) => {
    if (!enabled || !mountedRef.current) return null;
    const eventName = String(event || "").trim() || "unknown";
    const safePayload = sanitizePayload(payload);
    const nextSeq = seqRef.current + 1;
    seqRef.current = nextSeq;
    const nextEntry = createEntry({
      sessionId: sessionIdRef.current,
      seq: nextSeq,
      at: new Date().toISOString(),
      event: eventName,
      payload: safePayload,
    });
    bufferRef.current.push(nextEntry);
    if (bufferRef.current.length > bufferMax) {
      const evictedCount = bufferRef.current.length - bufferMax;
      bufferRef.current.splice(0, evictedCount);
      bufferEvictedCountRef.current += evictedCount;
    }
    if (runnerUrl.trim() && runnerToken.trim()) {
      scheduleFlush(flushDelayMs);
    }
    return nextEntry;
  }, [
    bufferMax,
    createEntry,
    enabled,
    flushDelayMs,
    runnerToken,
    runnerUrl,
    scheduleFlush,
  ]);

  useEffect(() => {
    if (!enabled) { clearFlushTimer(); return; }
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    if (bufferRef.current.length <= 0) return;
    scheduleFlush(240);
  }, [clearFlushTimer, enabled, runnerToken, runnerUrl, scheduleFlush]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearFlushTimer();
    };
  }, [clearFlushTimer]);

  return {
    sessionIdRef,
    enqueue,
    flush,
    clearFlushTimer,
  };
}
