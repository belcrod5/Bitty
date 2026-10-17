let pendingOrchestratorId = "";
const listeners = new Set<() => void>();

export function setPendingVoiceOrchestratorId(id: string): void {
  if (!id) return;
  pendingOrchestratorId = id;
  for (const listener of listeners) listener();
}

export function getPendingVoiceOrchestratorId(): string {
  return pendingOrchestratorId;
}

export function clearPendingVoiceOrchestratorId(id: string): void {
  if (pendingOrchestratorId === id) pendingOrchestratorId = "";
}

export function subscribePendingVoiceOrchestratorId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
