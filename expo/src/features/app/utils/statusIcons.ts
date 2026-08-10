import { buildToolDisplayLabel, toolNameToStatusLabel } from "./tooling";

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

export type SessionActivity = "reading" | "writing" | "thinking" | "web";
export type CodexItemRuntimeStatus = {
  status: "model_processing" | "model_generating" | "tool_running";
  detail: string;
};

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

export function resolveCodexItemRuntimeStatus(
  itemRaw: unknown,
  phase: "started" | "completed" = "started"
): CodexItemRuntimeStatus | null {
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
  const itemType = String(item.type || "").trim();
  if (phase === "completed") {
    const startedStatus = resolveCodexItemRuntimeStatus(item, "started");
    return startedStatus && itemType !== "agentMessage"
      ? { status: "model_processing", detail: `${itemType} completed` }
      : null;
  }
  if (itemType === "agentMessage") return { status: "model_generating", detail: "agent message started" };
  if (itemType === "fileChange") return { status: "tool_running", detail: "tool start: file_edit" };
  if (itemType === "webSearch") return { status: "tool_running", detail: "tool start: web_search" };
  if (itemType === "imageView") return { status: "tool_running", detail: "tool start: file_open" };
  if (itemType === "commandExecution") {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const actionTypes = actions.map((action) => String(
      action && typeof action === "object" ? (action as Record<string, unknown>).type : ""
    ));
    const toolName = actionTypes.includes("read")
      ? "read_file"
      : actionTypes.includes("listFiles")
        ? "list_dir"
        : actionTypes.includes("search")
          ? "search_text"
          : "restricted_exec";
    return { status: "tool_running", detail: `tool start: ${toolName}` };
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const toolName = String(item.toolName || item.tool || "").trim();
    if (!toolName) return { status: "model_processing", detail: `${itemType} started` };
    return {
      status: "tool_running",
      detail: `tool start: ${buildToolDisplayLabel(toolName, item.arguments)}`,
    };
  }
  if (
    itemType === "reasoning" ||
    itemType === "plan" ||
    itemType === "collabAgentToolCall" ||
    itemType === "subAgentActivity" ||
    itemType === "contextCompaction"
  ) {
    return { status: "model_processing", detail: `${itemType} started` };
  }
  return null;
}

export function resolvePixelStatusIconKey(status: LlmUiStatus | string, detail: string): PixelStatusIconKey {
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

export function resolveSessionActivity(
  status: LlmUiStatus | string | undefined,
  detail: string
): SessionActivity | null {
  if (!status || status === "idle" || status === "completed" || status === "error") return null;
  const normalizedDetail = String(detail || "");
  if (/(?:toolrun:|tool start:\s*)(brave_search|youtube_search|youtube_channel_latest|web_search)/i.test(normalizedDetail)) {
    return "web";
  }
  const iconKey = resolvePixelStatusIconKey(status, normalizedDetail);
  if (iconKey === "file_open" || iconKey === "search_dir" || iconKey === "find_files" || iconKey === "search_text") {
    return "reading";
  }
  if (iconKey === "file_write" || iconKey === "file_edit" || iconKey === "model_generating") {
    return "writing";
  }
  return "thinking";
}
