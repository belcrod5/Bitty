// A shared read model for foreground and background clients. No turns, history or task mutations.
export function createAppStatusSnapshot({ listOrchestrators, countActiveSessions, taskOverview, currentUsage, now = Date.now }) {
  return async function snapshot() {
    const [metadata, running, overview, usage] = await Promise.allSettled([
      listOrchestrators(), countActiveSessions(), taskOverview(), currentUsage(),
    ]);
    const value = (result) => result.status === "fulfilled" ? result.value : null;
    const list = value(metadata);
    if (!Array.isArray(list?.orchestrators) || !list.orchestrators.length || typeof list.selectedId !== "string") {
      throw new Error("orchestrator metadata unavailable");
    }
    const display = value(overview);
    const quota = value(usage);
    const markdown = display?.status === "present" && typeof display.markdown === "string" ? display.markdown : "";
    const text = markdown.split(/\r?\n/u).map((line) => line
      .replace(/^\s*(?:[-*+]\s*)?\[[ xX]\]\s*/u, "")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/u, "")
      .replace(/\*\*([^*]+)\*\*/gu, "$1").trim())
      .filter(Boolean).slice(0, 8).join("\n").slice(0, 1200);
    return {
      version: 1, connected: true,
      orchestrators: (list?.orchestrators || []).map(({ id, name, icon }) => ({ id, name, icon })),
      selectedId: list?.selectedId || "", runningCount: value(running)?.count ?? null,
      overview: text, overviewFetchedAt: overview.status === "fulfilled" ? now() : 0,
      fiveHourRemaining: quota?.fiveHourRemaining ?? null, weeklyRemaining: quota?.weeklyRemaining ?? null,
      usageLimitReached: quota?.usageLimitReached === true,
      usageFetchedAt: Date.parse(quota?.fetchedAt || "") || 0,
    };
  };
}
