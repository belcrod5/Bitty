export type ApprovalSource = "codex-app-server";

export type ApprovalAction =
  | "approve_once"
  | "approve_for_session"
  | "decline"
  | "cancel";

export type ApprovalSessionInfo = {
  panelId?: string;
  sessionId?: string;
  directoryPath?: string;
  directoryDisplayName?: string;
  sessionTitle?: string;
};

export type ApprovalRequest = {
  requestId: string;
  source: ApprovalSource;
  command: string;
  args: unknown[];
  reason: string;
  approvalKey: string;
  message: string;
  threadId: string;
  turnId: string;
  sessionInfo?: ApprovalSessionInfo;
};

export type ApprovalResponder = (action: ApprovalAction) => void | Promise<void>;

export type ApprovalQueueItem = {
  request: ApprovalRequest;
  respond: (action: ApprovalAction) => Promise<void>;
};

export type ApprovalQueueController = {
  enqueue: (request: ApprovalRequest, responder: ApprovalResponder) => void;
  shift: () => ApprovalQueueItem | null;
  discard: (
    shouldClear?: (request: ApprovalRequest) => boolean
  ) => void;
  size: () => number;
};

export function isApprovalAction(raw: unknown): raw is ApprovalAction {
  return (
    raw === "approve_once" ||
    raw === "approve_for_session" ||
    raw === "decline" ||
    raw === "cancel"
  );
}

function approvalRequestKey(request: ApprovalRequest) {
  const requestId = String(request.requestId || "").trim();
  if (!requestId) return "";
  const sessionId = String(request.sessionInfo?.sessionId || request.threadId || "").trim();
  return `${request.source}:${sessionId}:${requestId}`;
}

export function createApprovalQueueController(): ApprovalQueueController {
  const queue: Array<{
    item: ApprovalQueueItem;
    key: string;
  }> = [];
  const pendingByKey = new Map<string, ApprovalResponder[]>();

  return {
    enqueue(request, responder) {
      const key = approvalRequestKey(request);
      const existingResponders = key ? pendingByKey.get(key) : null;
      if (existingResponders) {
        existingResponders.push(responder);
        return;
      }
      const responders = [responder];
      if (key) {
        pendingByKey.set(key, responders);
      }
      let responded = false;
      queue.push({
        key,
        item: {
          request,
          async respond(action) {
            if (responded) return;
            if (!isApprovalAction(action)) {
              throw new Error(`Invalid approval action: ${String(action)}`);
            }
            responded = true;
            try {
              while (responders.length > 0) {
                const batch = responders.splice(0);
                await Promise.all(
                  batch.map((respond) => Promise.resolve().then(() => respond(action)))
                );
              }
            } finally {
              if (key && pendingByKey.get(key) === responders) {
                pendingByKey.delete(key);
              }
            }
          },
        },
      });
    },
    shift() {
      return queue.shift()?.item ?? null;
    },
    discard(shouldClear) {
      if (shouldClear) {
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const entry = queue[index];
          if (entry && shouldClear(entry.item.request)) {
            queue.splice(index, 1);
            if (entry.key) {
              pendingByKey.delete(entry.key);
            }
          }
        }
        return;
      }
      queue.splice(0, queue.length);
      pendingByKey.clear();
    },
    size() {
      return queue.length;
    },
  };
}
