import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  CodexCliStatusSnapshot,
  LlmBackend,
  LlmRuntimeLimitsSnapshot,
  ReplyRequestSessionSnapshot,
  SttMessageMeta,
} from "../types/appTypes";
import type { CodexApprovalPolicy, ReasoningEffort } from "../utils/settingsParsers";

type RunSlashStatusOptions = {
  sttMeta?: SttMessageMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
};

type UseSlashStatusCommandControllerArgs = {
  fetchRunnerCodexCliStatusForSlash: () => Promise<CodexCliStatusSnapshot | null>;
  applyCodexCliStatusSnapshot: (snapshot: CodexCliStatusSnapshot) => void;
  fetchRunnerLlmRuntimeLimitsForStatus: () => Promise<LlmRuntimeLimitsSnapshot | null>;
  llmRuntimeLimits: LlmRuntimeLimitsSnapshot | null;
  llmBackend: LlmBackend;
  normalizedLlmDirectoryForRequest: () => string;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  codexApprovalPolicy: CodexApprovalPolicy;
  chatContextUsedPct: number | null;
  appendSlashCommandResult: (commandText: string, assistantText: string, options?: RunSlashStatusOptions) => void;
  setReplyDebug: Dispatch<SetStateAction<string>>;
};

function shouldProjectSlashDebugToActiveSession(panelIdRaw: unknown) {
  void panelIdRaw;
  return false;
}

export function useSlashStatusCommandController({
  fetchRunnerCodexCliStatusForSlash,
  applyCodexCliStatusSnapshot,
  fetchRunnerLlmRuntimeLimitsForStatus,
  llmRuntimeLimits,
  llmBackend,
  normalizedLlmDirectoryForRequest,
  modelRef,
  reasoningEffort,
  codexApprovalPolicy,
  chatContextUsedPct,
  appendSlashCommandResult,
  setReplyDebug,
}: UseSlashStatusCommandControllerArgs) {
  const runSlashStatusCommand = useCallback(async (
    commandText: string,
    options?: RunSlashStatusOptions
  ) => {
    const projectDebugToActiveSession = shouldProjectSlashDebugToActiveSession(options?.panelId);
    const codexCliStatus = await fetchRunnerCodexCliStatusForSlash();
    if (codexCliStatus?.statusText) {
      applyCodexCliStatusSnapshot(codexCliStatus);
      appendSlashCommandResult(commandText, `\`\`\`\n${codexCliStatus.statusText}\n\`\`\``, options);
      if (projectDebugToActiveSession) {
        setReplyDebug(
          `slash /status source=codex_cli limits=${codexCliStatus.limitLines.length} fetchedAt=${codexCliStatus.fetchedAt}`
        );
      }
      return true;
    }
    const latestLimits = await fetchRunnerLlmRuntimeLimitsForStatus();
    const snapshot = latestLimits || llmRuntimeLimits;
    const lines = [
      "現在の状態:",
      `- backend: ${llmBackend}`,
      `- sessionId: ${options?.sessionSnapshot?.sessionId || options?.sessionSnapshot?.threadId || "-"}`,
      `- directory: ${options?.sessionSnapshot?.directory || normalizedLlmDirectoryForRequest()}`,
      `- model: ${modelRef || "(server default)"}`,
      `- think: ${reasoningEffort}`,
      `- approvalPolicy: ${codexApprovalPolicy}`,
      `- contextUsedPct: ${chatContextUsedPct === null ? "--" : `${chatContextUsedPct}%`}`,
      `- toolMaxRounds: ${snapshot?.toolMaxRounds ?? "-"}`,
      `- llmTimeoutMs: ${snapshot?.llmTimeoutMs ?? "-"}`,
      `- approvalTimeoutMs: ${snapshot?.approvalTimeoutMs ?? "-"}`,
    ];
    appendSlashCommandResult(commandText, lines.join("\n"), options);
    if (projectDebugToActiveSession) {
      setReplyDebug(`slash /status source=fallback session=${options?.sessionSnapshot?.sessionId || options?.sessionSnapshot?.threadId || "-"}`);
    }
    return true;
  }, [
    appendSlashCommandResult,
    applyCodexCliStatusSnapshot,
    chatContextUsedPct,
    codexApprovalPolicy,
    fetchRunnerCodexCliStatusForSlash,
    fetchRunnerLlmRuntimeLimitsForStatus,
    llmBackend,
    llmRuntimeLimits,
    modelRef,
    normalizedLlmDirectoryForRequest,
    reasoningEffort,
    setReplyDebug,
  ]);

  return {
    runSlashStatusCommand,
  };
}
