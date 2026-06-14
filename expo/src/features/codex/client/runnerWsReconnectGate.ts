type RunnerWsReconnectGateOptions = {
  minSpacingMs?: number;
  jitterMs?: number;
};

type RunnerWsReconnectGateState = {
  nextAllowedAt: number;
};

const reconnectGateByKey = new Map<string, RunnerWsReconnectGateState>();

export function reserveRunnerWsReconnectDelay(
  keyRaw: unknown,
  options: RunnerWsReconnectGateOptions = {}
): number {
  const key = String(keyRaw || "").trim();
  if (!key) return 0;

  const minSpacingMs = Number.isFinite(Number(options.minSpacingMs))
    ? Math.max(0, Math.floor(Number(options.minSpacingMs)))
    : 250;
  const jitterMs = Number.isFinite(Number(options.jitterMs))
    ? Math.max(0, Math.floor(Number(options.jitterMs)))
    : 200;

  const now = Date.now();
  const state = reconnectGateByKey.get(key) || { nextAllowedAt: 0 };
  const randomJitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  const baseWaitMs = Math.max(0, state.nextAllowedAt - now);
  const delayMs = baseWaitMs + randomJitter;

  state.nextAllowedAt = now + delayMs + minSpacingMs;
  reconnectGateByKey.set(key, state);
  return delayMs;
}

