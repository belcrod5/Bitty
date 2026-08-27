function terminalError(event) {
  const details = event?.payload?.error;
  const error = new Error(String(details?.message || "scheduled Codex turn ended before it started"));
  error.code = String(details?.code || event?.payload?.outcome || "turn_failed");
  return error;
}

export function createScheduledCodexTurnStarter({
  agentService,
  subjectId,
  dynamicToolResponse,
}) {
  return async function startScheduledCodexTurn({
    inputText,
    cwd,
    model = "",
    effort = "",
    threadId = "",
    clientOperationId,
  }) {
    const context = { subjectId };
    const run = await agentService.startTurn({
      backendId: "codex",
      ...(threadId ? { sessionRef: { backendId: "codex", nativeSessionId: threadId } } : {}),
      cwd,
      input: { blocks: [{ type: "text", text: inputText }] },
      model,
      effort,
      policyProfileId: "codex-on-request",
      clientOperationId,
    }, context);
    const actionConsumerId = {};
    let resolvedThreadId = threadId;
    let started = false;
    let resolveStarted;
    let rejectStarted;
    const startedPromise = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const handleDynamicTool = async (payload) => {
      const requestId = String(payload?.requestId || "");
      await agentService.claimAction(
        { runId: run.runId, requestId },
        { ...context, actionConsumerId },
      );
      const input = payload?.input || {};
      await agentService.respondToAction({
        runId: run.runId,
        requestId,
        decision: "result",
        result: dynamicToolResponse({ id: requestId, method: input.method, params: input.params }),
      }, { ...context, actionConsumerId });
    };

    const handleEvent = (event) => {
      if (event.type === "session.resolved") {
        resolvedThreadId = String(event.payload?.sessionRef?.nativeSessionId || "");
      } else if (event.type === "turn.started") {
        const turnId = String(event.payload?.nativeTurnId || "");
        if (!resolvedThreadId || !turnId) {
          const error = new Error("Codex start IDs are missing");
          error.code = "protocol_error";
          rejectStarted(error);
          return;
        }
        started = true;
        resolveStarted({ threadId: resolvedThreadId, turnId });
      } else if (event.type === "action.requested" && event.payload?.kind === "dynamic_tool") {
        void handleDynamicTool(event.payload).catch(async (error) => {
          if (!started) rejectStarted(error);
          await agentService.interrupt(run.runId, context).catch(() => {});
          console.warn(`[schedule] dynamic tool failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else if (["turn.completed", "turn.interrupted", "turn.failed"].includes(event.type) && !started) {
        rejectStarted(terminalError(event));
      }
    };

    const subscription = agentService.subscribe(run.runId, {
      onEvent: handleEvent,
      actionConsumerId,
      actionScope: "dynamic_tool",
    }, context);
    for (const action of subscription.activeActions) handleEvent({ type: "action.requested", payload: action });
    void run.completion.finally(() => subscription.unsubscribe());
    return await startedPromise;
  };
}
