type SessionExecutionStatusInput = {
  threadStatusType?: unknown;
  isResponding?: boolean;
  hasRunningTurn?: boolean;
  isCompactRunning?: boolean;
};

export function deriveSessionExecutionStatusType({
  threadStatusType,
  isResponding = false,
  hasRunningTurn = false,
  isCompactRunning = false,
}: SessionExecutionStatusInput) {
  const normalizedThreadStatus = String(threadStatusType || "").trim();
  if (normalizedThreadStatus === "waiting_approval") return normalizedThreadStatus;
  if (isResponding || hasRunningTurn || isCompactRunning) return "active";
  return normalizedThreadStatus || "unknown";
}
