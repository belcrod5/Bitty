import { useCallback, type Dispatch, type SetStateAction } from "react";
import { compactCodexAppServerThread } from "../../codex/codexAppServerClient";
import type { ReplyRequestSessionSnapshot, SttMessageMeta } from "../types/appTypes";
import { trimForInline } from "../utils/statusText";

type RunSlashCompactOptions = {
  sttMeta?: SttMessageMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
  contextUsedPct?: number | null;
};

type UseSlashCompactCommandControllerArgs = {
  codexWsUrl: string;
  codexWsToken: string;
  nearUnlimitedTimeoutMs: number;
  normalizedLlmDirectoryForRequest: () => string;
  fetchRunnerSessionContextUsedPct: (sessionId: string, directory: string) => Promise<number | null>;
  setReplyDebug: Dispatch<SetStateAction<string>>;
  appendSlashCommandResult: (commandText: string, assistantText: string, options?: RunSlashCompactOptions) => void;
  appendSlashCommandProgress: (commandText: string, assistantText: string, options?: RunSlashCompactOptions) => void;
  speakSlashCommandResult?: (assistantText: string) => Promise<void> | void;
  setCodexCompactRunning?: (threadId: string, running: boolean) => void;
  logSessionDiag?: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

function shouldProjectSlashDebugToActiveSession(panelIdRaw: unknown) {
  void panelIdRaw;
  return false;
}

export function useSlashCompactCommandController({
  codexWsUrl,
  codexWsToken,
  nearUnlimitedTimeoutMs,
  normalizedLlmDirectoryForRequest,
  fetchRunnerSessionContextUsedPct,
  setReplyDebug,
  appendSlashCommandResult,
  appendSlashCommandProgress,
  speakSlashCommandResult,
  setCodexCompactRunning,
  logSessionDiag,
}: UseSlashCompactCommandControllerArgs) {
  const runSlashCompactCommand = useCallback(async (
    commandText: string,
    options?: RunSlashCompactOptions
  ) => {
    const targetConversationId = String(options?.panelId || "").trim();
    const projectDebugToActiveSession = shouldProjectSlashDebugToActiveSession(targetConversationId);
    const appendFinalResult = (
      assistantText: string,
      resultOptions?: RunSlashCompactOptions,
      spokenText?: string
    ) => {
      appendSlashCommandResult(commandText, assistantText, resultOptions);
      if (speakSlashCommandResult) {
        void Promise.resolve(speakSlashCommandResult(spokenText || assistantText)).catch(() => {});
      }
    };
    const wsUrl = codexWsUrl.trim();
    const targetSnapshot = options?.sessionSnapshot;
    const threadId = String(
      targetSnapshot?.threadId ||
      targetSnapshot?.sessionId ||
      ""
    ).trim();
    const targetDirectory = String(
      targetSnapshot?.directory ||
      normalizedLlmDirectoryForRequest()
    ).trim();
    logSessionDiag?.("slash_compact_target_resolved", {
      panelId: targetConversationId || undefined,
      sessionId: String(targetSnapshot?.sessionId || "").trim() || undefined,
      threadId: threadId || undefined,
      directory: targetDirectory || undefined,
      source: String(targetSnapshot?.source || "").trim() || "global",
    }, { throttleMs: 0 });
    if (!wsUrl) {
      appendFinalResult("Codex WS URL が未設定のため /compact を実行できません。", options);
      return true;
    }
    if (!threadId) {
      appendFinalResult("セッションが未作成です。先に通常の会話を1回実行してから /compact を実行してください。", options);
      return true;
    }
    setCodexCompactRunning?.(threadId, true);
    appendSlashCommandProgress(
      commandText,
      "コンテキスト圧縮中です。完了まで待ってください。",
      options
    );
    if (projectDebugToActiveSession) {
      setReplyDebug(`slash /compact start chat=${targetConversationId || "-"} session=${threadId}`);
    }
    try {
      const compactResult = await compactCodexAppServerThread({
        wsUrl,
        wsToken: codexWsToken.trim(),
        threadId,
        timeoutMs: nearUnlimitedTimeoutMs,
        onLog: (entry) => {
          const suffix = [
            entry.method ? `method=${entry.method}` : "",
            Number.isFinite(Number(entry.id)) ? `id=${Number(entry.id)}` : "",
            Number.isFinite(Number(entry.readyState)) ? `readyState=${Number(entry.readyState)}` : "",
            entry.message ? `msg=${entry.message}` : "",
          ].filter(Boolean).join(" ");
          const line = suffix
            ? `compact_ws ${entry.stage} ${suffix}`
            : `compact_ws ${entry.stage}`;
          if (projectDebugToActiveSession) {
            setReplyDebug((prev) => (prev ? `${prev} | ${line}` : line));
          }
        },
        onEvent: (method, params) => {
          if (!method) return;
          if (
            method === "thread/compacted" ||
            method === "thread/status/changed" ||
            method === "turn/completed" ||
            method === "item/started" ||
            method === "item/completed" ||
            method === "error"
          ) {
            let detail = "";
            if (method === "thread/status/changed" && params && typeof params === "object") {
              const paramsRecord = params as Record<string, unknown>;
              const threadRecord = (
                paramsRecord.thread &&
                typeof paramsRecord.thread === "object"
              )
                ? paramsRecord.thread as Record<string, unknown>
                : {};
              const turnRecord = (
                paramsRecord.turn &&
                typeof paramsRecord.turn === "object"
              )
                ? paramsRecord.turn as Record<string, unknown>
                : {};
              const status = String(
                paramsRecord.status ||
                threadRecord.status ||
                turnRecord.status ||
                ""
              ).trim();
              if (status) detail = ` status=${status}`;
            }
            const line = `compact_evt ${method}${detail}`;
            if (projectDebugToActiveSession) {
              setReplyDebug((prev) => (prev ? `${prev} | ${line}` : line));
            }
          }
        },
      });
      const previousContextUsedPct = Number.isFinite(Number(options?.contextUsedPct))
        ? Math.max(0, Math.min(100, Math.round(Number(options?.contextUsedPct))))
        : null;
      let contextUsedPct: number | null = null;
      for (const delayMs of [0, 500, 1000, 1500, 2500]) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
        const nextContextUsedPct = await fetchRunnerSessionContextUsedPct(
          threadId,
          targetDirectory
        ).catch(() => null);
        if (nextContextUsedPct === null) continue;
        contextUsedPct = nextContextUsedPct;
        if (previousContextUsedPct === null || nextContextUsedPct < previousContextUsedPct) {
          break;
        }
      }
      const lines = [
        "コンテキスト圧縮が完了しました。",
        `- sessionId: ${threadId}`,
        `- method: ${compactResult.method}`,
        `- contextUsedPct: ${contextUsedPct !== null ? `${contextUsedPct}%` : "(更新取得なし)"}`,
        "- same sessionId で継続します。",
      ];
      appendFinalResult(lines.join("\n"), {
        ...options,
        contextUsedPct,
      }, "コンテキスト圧縮が完了しました。");
      if (projectDebugToActiveSession) {
        setReplyDebug(`slash /compact ok chat=${targetConversationId || "-"} session=${threadId} method=${compactResult.method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFinalResult(`コンテキスト圧縮に失敗しました: ${message}`, options);
      if (projectDebugToActiveSession) {
        setReplyDebug(`slash /compact error chat=${targetConversationId || "-"} ${trimForInline(message, 180)}`);
      }
    } finally {
      setCodexCompactRunning?.(threadId, false);
    }
    return true;
  }, [
    appendSlashCommandResult,
    appendSlashCommandProgress,
    codexWsToken,
    codexWsUrl,
    fetchRunnerSessionContextUsedPct,
    logSessionDiag,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
    setReplyDebug,
    setCodexCompactRunning,
    speakSlashCommandResult,
  ]);

  return {
    runSlashCompactCommand,
  };
}
