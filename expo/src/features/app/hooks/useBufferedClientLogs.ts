import { useCallback, useEffect, useRef, useState } from "react";
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
  const [queuedCount, setQueuedCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [status, setStatus] = useState("idle");

  const clearFlushTimer = useCallback(() => {
    if (!flushTimerRef.current) return;
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }, []);

  const flush = useCallback(async (flushOptions?: FlushOptions) => {
    if (!enabled) return;
    if (flushInFlightRef.current) return;
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    if (bufferRef.current.length <= 0) return;
    flushInFlightRef.current = true;
    clearFlushTimer();
    try {
      const maxBatches = Math.max(1, Math.floor(Number(flushOptions?.maxBatches || 1)));
      let sentTotal = 0;
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
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
            events: batch,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        bufferRef.current.splice(0, batch.length);
        sentTotal += batch.length;
        setQueuedCount(bufferRef.current.length);
      }
      if (sentTotal > 0) {
        setSentCount((prev) => prev + sentTotal);
        setStatus(`sent:${sentTotal}`);
      } else {
        setStatus("idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`error:${message}`);
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          void flush();
        }, Math.max(0, retryMs));
      }
    } finally {
      flushInFlightRef.current = false;
      if (bufferRef.current.length > 0 && !flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          void flush();
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

  const scheduleFlush = useCallback((delayMs = flushDelayMs) => {
    if (!enabled) return;
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flush();
    }, Math.max(0, delayMs));
  }, [enabled, flush, flushDelayMs]);

  const enqueue = useCallback((event: string, payload: Record<string, unknown>) => {
    if (!enabled) return null;
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
      bufferRef.current.splice(0, bufferRef.current.length - bufferMax);
    }
    const nextQueuedCount = bufferRef.current.length;
    setQueuedCount(nextQueuedCount);
    setStatus(`queued:${nextQueuedCount}`);
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

  const sendNow = useCallback(async () => {
    if (!enabled) return;
    setStatus("sending");
    await flush({ maxBatches: 12 });
  }, [enabled, flush]);

  const clearLocal = useCallback(() => {
    bufferRef.current = [];
    setQueuedCount(0);
    setStatus("cleared");
    clearFlushTimer();
  }, [clearFlushTimer]);

  useEffect(() => {
    if (!enabled) return;
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    if (bufferRef.current.length <= 0) return;
    scheduleFlush(240);
  }, [enabled, runnerToken, runnerUrl, scheduleFlush]);

  useEffect(() => {
    return () => {
      clearFlushTimer();
    };
  }, [clearFlushTimer]);

  return {
    sessionIdRef,
    queuedCount,
    sentCount,
    status,
    enqueue,
    flush,
    sendNow,
    clearLocal,
    clearFlushTimer,
  };
}
