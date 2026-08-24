type JsonRecord = Record<string, unknown>;

export function deriveAgentSessionLiveState(activeRunRaw: unknown) {
  const activeRun = activeRunRaw && typeof activeRunRaw === "object"
    ? activeRunRaw as JsonRecord
    : null;
  const hasRunningTurn = Boolean(String(activeRun?.runId || "").trim());
  const waitingOnApproval = hasRunningTurn && activeRun?.waitingForAction === true;
  return {
    sessionState: hasRunningTurn
      ? waitingOnApproval ? "waiting_on_approval" as const : "running" as const
      : "completed" as const,
    threadStatusType: hasRunningTurn
      ? waitingOnApproval ? "waiting_approval" as const : "active" as const
      : "idle" as const,
    waitingOnApproval,
    latestTurnStatus: hasRunningTurn
      ? waitingOnApproval ? "waiting_on_approval" : String(activeRun?.state || "running")
      : "completed",
    hasRunningTurn,
    runningTurn: hasRunningTurn ? {
      status: waitingOnApproval ? "waiting_approval" : String(activeRun?.state || "running"),
      summary: waitingOnApproval ? "approval required" : "agent turn running",
      startedAt: String(activeRun?.startedAt || ""),
      updatedAt: String(activeRun?.updatedAt || ""),
    } : null,
  };
}
