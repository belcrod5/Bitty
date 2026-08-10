import { resolveCodexItemRuntimeStatus, resolveSessionActivity } from "./statusIcons";

test("maps live status details to the four board activity kinds", () => {
  expect(resolveSessionActivity("tool_running", "tool start: file_open")).toBe("reading");
  expect(resolveSessionActivity("tool_running", "tool start: file_edit")).toBe("writing");
  expect(resolveSessionActivity("model_processing", "turn started")).toBe("thinking");
  expect(resolveSessionActivity("tool_running", "toolrun:brave_search")).toBe("web");
  expect(resolveSessionActivity("completed", "reply received")).toBeNull();
});

test("normalizes real Codex ThreadItem starts into shared runtime statuses", () => {
  expect(resolveCodexItemRuntimeStatus({
    type: "commandExecution",
    commandActions: [{ type: "search", command: "rg x", query: "x", path: "." }],
  })).toEqual({ status: "tool_running", detail: "tool start: search_text" });
  expect(resolveCodexItemRuntimeStatus({ type: "fileChange", changes: [] })).toEqual({
    status: "tool_running",
    detail: "tool start: file_edit",
  });
  expect(resolveCodexItemRuntimeStatus({ type: "webSearch", query: "news" })).toEqual({
    status: "tool_running",
    detail: "tool start: web_search",
  });
  expect(resolveCodexItemRuntimeStatus({
    type: "dynamicToolCall",
    toolName: "read_file",
    arguments: { path: "README.md" },
  })).toEqual({ status: "tool_running", detail: "tool start: file_open" });
  expect(resolveCodexItemRuntimeStatus({
    type: "dynamicToolCall",
    toolName: "brave_search",
    arguments: { query: "news" },
  })).toEqual({ status: "tool_running", detail: "tool start: brave_search" });
  expect(resolveCodexItemRuntimeStatus({
    type: "mcpToolCall",
    tool: "read_file",
    arguments: { path: "README.md" },
  })).toEqual({ status: "tool_running", detail: "tool start: file_open" });
  expect(resolveCodexItemRuntimeStatus({ type: "webSearch" }, "completed")).toEqual({
    status: "model_processing",
    detail: "webSearch completed",
  });
  expect(resolveCodexItemRuntimeStatus({ type: "agentMessage" }, "completed")).toBeNull();
});

test("maps normalized real Codex item statuses to board activity", () => {
  for (const [item, activity] of [
    [{ type: "commandExecution", commandActions: [{ type: "read" }] }, "reading"],
    [{ type: "fileChange" }, "writing"],
    [{ type: "webSearch" }, "web"],
    [{ type: "dynamicToolCall", toolName: "brave_search", arguments: { query: "news" } }, "web"],
  ] as const) {
    const runtime = resolveCodexItemRuntimeStatus(item);
    expect(resolveSessionActivity(runtime?.status, runtime?.detail || "")).toBe(activity);
  }
});
