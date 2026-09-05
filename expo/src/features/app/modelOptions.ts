import type { BackendStatus } from "../agent/client";
import type { ModelOption } from "./contexts/AppSettingsContext";
import type { LlmBackend } from "./types/appTypes";
import { isReasoningEffort, type CodexApprovalPolicy, type ReasoningEffort } from "./utils/settingsParsers";

export const DEFAULT_LLM_BACKEND: LlmBackend = "codex";
export const DEFAULT_MODEL_REF = "";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
export const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = "on-request";
export const THINK_OPTIONS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

function parseEffortOptions(raw: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(isReasoningEffort);
  return parsed.length > 0 ? parsed : undefined;
}

// Backendがadvertiseしたeffort catalogを描画・検証の唯一のソースにする。
// advertiseが無い場合のみ全値fallback(旧Backend statusとの互換)。
export function effortOptionsForModel(
  option: { supportsReasoningEffort?: boolean; effortOptions?: readonly ReasoningEffort[] } | undefined,
): readonly ReasoningEffort[] {
  if (option?.supportsReasoningEffort !== true) return [];
  return option.effortOptions ?? THINK_OPTIONS;
}

export function modelSelectionKey(backendIdRaw: unknown, modelIdRaw: unknown): ModelOption["selectionKey"] {
  const backendId = encodeURIComponent(String(backendIdRaw || "").trim());
  const modelId = encodeURIComponent(String(modelIdRaw || "").trim());
  return `${backendId}::${modelId}` as ModelOption["selectionKey"];
}

export function modelOptionsFromStatuses(statuses: readonly BackendStatus[]): ModelOption[] {
  return statuses.flatMap((status) => {
    const backendId = String(status.backendId || "").trim();
    if (!backendId) return [];
    const capability = status.capabilities?.model;
    return (capability?.catalog || []).flatMap((model) => {
      const modelId = String(model.modelId || "").trim();
      if (!modelId) return [];
      return [{
        selectionKey: modelSelectionKey(backendId, modelId),
        backendId,
        modelId,
        label: String(model.label || modelId).trim() || modelId,
        supportsReasoningEffort: capability?.effort === true,
        effortOptions: model.effortOptions === undefined
          ? parseEffortOptions(capability?.effortOptions)
          : parseEffortOptions(model.effortOptions) ?? [],
        supportsScheduling: status.capabilities?.operations?.schedule === true,
        selectable: true,
      }];
    });
  });
}

export function currentModelFallback(
  backendId: string,
  modelId: string,
  capability?: { effort?: boolean; effortOptions?: string[]; schedule?: boolean },
): ModelOption {
  return {
    selectionKey: modelSelectionKey(backendId, modelId),
    backendId,
    modelId,
    label: modelId,
    supportsReasoningEffort: capability?.effort === true,
    effortOptions: parseEffortOptions(capability?.effortOptions),
    supportsScheduling: capability?.schedule === true,
    selectable: false,
  };
}

export function isBackendChangeBlocked(options: {
  sessionLocked: boolean;
  currentBackendId: string;
  nextBackendId: string;
}) {
  return options.sessionLocked && options.nextBackendId !== options.currentBackendId;
}
