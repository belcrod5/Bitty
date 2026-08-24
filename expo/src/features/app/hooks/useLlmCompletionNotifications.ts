import { useCallback, useState } from "react";
import type { LlmCompletionNotification } from "../components/LlmCompletionNotifications";
import { parseOptionalSessionId } from "../utils/llmSession";

type CompletionContext = { directoryDisplayName?: string } | null;

export function useLlmCompletionNotifications(options: {
  handleForegroundSessionCompletion: (params: {
    backendId: string;
    sessionId: string;
    directory?: string;
  }) => boolean;
  resolveSessionHistoryContext: (sessionId: string, backendId?: string) => CompletionContext;
}) {
  const [notifications, setNotifications] = useState<LlmCompletionNotification[]>([]);
  const pushNotification = useCallback((params: {
    backendId?: string;
    sessionId: string;
    threadId: string;
    directory?: string;
    previewText: string;
    completedAtMs?: number;
  }) => {
    const backendId = String(params.backendId || "codex").trim() || "codex";
    const sessionId = parseOptionalSessionId(params.sessionId || params.threadId);
    const threadId = parseOptionalSessionId(params.threadId || sessionId);
    const previewText = String(params.previewText || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!sessionId || !threadId) return;
    if (options.handleForegroundSessionCompletion({ backendId, sessionId, directory: params.directory })) return;
    // Text-free lifecycle boundaries still own read/badge reconciliation. Only the local
    // completion card requires preview text.
    if (!previewText) return;
    const context = options.resolveSessionHistoryContext(sessionId, backendId);
    const completedAtMs = Number.isFinite(Number(params.completedAtMs))
      ? Math.floor(Number(params.completedAtMs))
      : Date.now();
    const nextNotification: LlmCompletionNotification = {
      id: `${backendId}:${sessionId}:${completedAtMs}`,
      backendId,
      sessionId,
      threadId,
      directoryName: context?.directoryDisplayName || String(params.directory || "").trim(),
      previewText,
      completedAt: new Date(completedAtMs).toISOString(),
    };
    setNotifications((current) => {
      const next = current.filter((item) => (
        item.backendId !== backendId || item.sessionId !== sessionId
      ) && item.id !== nextNotification.id);
      return [nextNotification, ...next].slice(0, 3);
    });
  }, [options.handleForegroundSessionCompletion, options.resolveSessionHistoryContext]);
  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  return { notifications, pushNotification, dismissNotification };
}
