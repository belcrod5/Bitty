export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type CodexApprovalPolicy = "on-request" | "never";

export function isReasoningEffort(raw: unknown): raw is ReasoningEffort {
  const value = String(raw || "").trim().toLowerCase();
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

type ModelOption = {
  label?: string;
  value: string;
};

export function normalizeModelRef(raw: unknown) {
  const rawValue = String(raw || "").trim();
  if (rawValue.startsWith("openai-codex/")) {
    return rawValue.slice("openai-codex/".length).trim();
  }
  return rawValue;
}

export function formatModelRefForDisplay(raw: unknown) {
  return normalizeModelRef(raw) || "-";
}

export function modelRefLabelForDisplay(raw: unknown, modelOptions: readonly ModelOption[]) {
  const value = normalizeModelRef(raw);
  if (!value) return "-";
  return modelOptions.find((item) => item.value === value)?.label || value;
}

export function parseModelRef(raw: unknown, modelOptions: readonly ModelOption[], fallback: string) {
  const value = normalizeModelRef(raw);
  if (!value) return fallback;
  if (modelOptions.some((item) => item.value === value)) return value;
  return fallback;
}

export function parseReasoningEffort(raw: unknown, fallback: ReasoningEffort): ReasoningEffort {
  const value = String(raw || "").trim().toLowerCase();
  if (isReasoningEffort(value)) return value;
  return fallback;
}

export function parseCodexApprovalPolicy(raw: unknown): CodexApprovalPolicy {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "never") return "never";
  return "on-request";
}

export function parseLlmDirectory(raw: unknown, fallback = "llm_root") {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  return value;
}
