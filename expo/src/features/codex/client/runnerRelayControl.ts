import { parseRunnerWsRelayControlMessage } from "../../runnerWs/llmAdapter";

export type RunnerRelayControlMessage = {
  type: string;
  seq?: number;
  replayed?: number;
  latestSeq?: number;
  reason?: string;
};

export function buildRunnerRelayResumeWsUrl(wsUrlRaw: string, threadIdRaw: string, lastSeqRaw: number): string {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return wsUrlRaw;
  const lastSeq = Number.isFinite(Number(lastSeqRaw))
    ? Math.max(0, Math.floor(Number(lastSeqRaw)))
    : 0;
  try {
    const parsed = new URL(wsUrlRaw);
    parsed.searchParams.set("resumeThreadId", threadId);
    parsed.searchParams.set("resumeFromSeq", String(lastSeq));
    return parsed.toString();
  } catch {
    return wsUrlRaw;
  }
}

export function parseRunnerRelayControlMessage(rawData: string): RunnerRelayControlMessage | null {
  const raw = String(rawData || "").trim();
  if (!raw || raw.length > 2000) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") return null;
    const runnerWsControl = parseRunnerWsRelayControlMessage(raw);
    if (runnerWsControl) return runnerWsControl;
    const type = String((payload as any)?.type || "").trim();
    if (!type.startsWith("runner_relay_")) return null;
    const seq = Number((payload as any)?.seq);
    const replayed = Number((payload as any)?.replayed);
    const latestSeq = Number((payload as any)?.latestSeq);
    const reason = String((payload as any)?.reason || "").trim();
    return {
      type,
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
      replayed: Number.isFinite(replayed) ? Math.max(0, Math.floor(replayed)) : undefined,
      latestSeq: Number.isFinite(latestSeq) ? Math.max(0, Math.floor(latestSeq)) : undefined,
      reason: reason || undefined,
    };
  } catch {
    return null;
  }
}
