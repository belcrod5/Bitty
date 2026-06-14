import { formatElapsedMmSs } from "./formatting";
import { liveLlmStatusPrefix } from "./statusText";
import type { LlmUiStatus } from "../hooks/useLlmRequestStatus";

export function liveLlmStatusDetail(status: LlmUiStatus, baseDetail: string, elapsedMs: number) {
  const elapsedLabel = formatElapsedMmSs(elapsedMs);
  const prefix = liveLlmStatusPrefix(status);
  const detail = String(baseDetail || "").trim();
  if (detail) return `${prefix} ${elapsedLabel} | ${detail}`;
  return `${prefix} ${elapsedLabel}`;
}
