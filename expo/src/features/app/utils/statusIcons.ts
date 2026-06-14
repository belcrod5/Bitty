import { toolNameToStatusLabel } from "./tooling";

export type PixelStatusIconKey =
  | "idle"
  | "connecting"
  | "model_processing"
  | "tool_waiting_approval"
  | "tool_running"
  | "model_generating"
  | "search_dir"
  | "find_files"
  | "search_text"
  | "file_open"
  | "file_write"
  | "file_edit"
  | "restricted_exec"
  | "completed"
  | "error";

type LlmUiStatus =
  | "idle"
  | "connecting"
  | "model_processing"
  | "tool_waiting_approval"
  | "tool_running"
  | "model_generating"
  | "completed"
  | "error";

const TOOL_PIXEL_ICON_KEYS: Record<string, PixelStatusIconKey> = {
  search_dir: "search_dir",
  find_files: "find_files",
  search_text: "search_text",
  file_open: "file_open",
  file_write: "file_write",
  file_edit: "file_edit",
  restricted_exec: "restricted_exec",
};

export function resolvePixelStatusIconKey(status: LlmUiStatus, detail: string): PixelStatusIconKey {
  if (status === "tool_running") {
    const rawDetail = String(detail || "");
    const match = rawDetail.match(/tool start:\s*([^\s]+)/i);
    if (match) {
      const label = toolNameToStatusLabel(match[1]);
      const iconKey = TOOL_PIXEL_ICON_KEYS[label];
      if (iconKey) return iconKey;
    }
    return "tool_running";
  }
  if (status === "tool_waiting_approval") return "tool_waiting_approval";
  if (status === "model_generating") return "model_generating";
  if (status === "model_processing") return "model_processing";
  if (status === "connecting") return "connecting";
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  return "idle";
}
