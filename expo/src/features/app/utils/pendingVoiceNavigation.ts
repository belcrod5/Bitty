let pendingOrchestratorId = "";
let pendingControlSignal: AbortSignal | undefined;
const listeners = new Set<() => void>();

export function setPendingVoiceOrchestratorId(id: string, signal?: AbortSignal): void {
  if (!id || signal?.aborted) return;
  pendingOrchestratorId = id;
  pendingControlSignal = signal;
  signal?.addEventListener("abort", () => {
    if (pendingControlSignal === signal) clearPendingVoiceOrchestratorId(id);
  }, { once: true });
  for (const listener of listeners) listener();
}

export function getPendingVoiceControlSignal() { return pendingControlSignal; }

export function getPendingVoiceOrchestratorId(): string {
  return pendingOrchestratorId;
}

export function clearPendingVoiceOrchestratorId(id: string): void {
  if (!id || pendingOrchestratorId !== id) return;
  pendingOrchestratorId = "";
  pendingControlSignal = undefined;
  for (const listener of listeners) listener();
}

export function subscribePendingVoiceOrchestratorId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
