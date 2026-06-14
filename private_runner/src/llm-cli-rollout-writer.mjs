import path from "node:path";
import { promises as fs } from "node:fs";

export function createLlmCliRolloutWriter(deps = {}) {
  const {
    buildTokenCountPayloadFromContextUsage,
    cliSessionMetaOriginator,
    cliSessionMetaSource,
    cliSessionMetaVersion,
    codeCliSessionsDir,
    ensureCliSessionIndexLoaded,
    normalizeLlmExecutionSessionId,
    normalizeReasoningEffort,
    normalizeSessionRootRelativePath,
    normalizeSessionUpdatedAt,
    selectCliSessionIndexEntryBySessionId,
    toWorkspaceRelativeFromAbsolutePath,
    upsertCliSessionIndexEntryFromRolloutFile,
    workspaceRoot,
  } = deps;

  let appCliRolloutWriteQueue = Promise.resolve();
  const appCliRolloutBySessionId = new Map();

  function formatCliRolloutPathDateParts(date = new Date()) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return { year, month, day };
  }

  function formatCliRolloutFileStamp(date = new Date()) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}T${hour}-${minute}-${second}`;
  }

  function buildCliRolloutFilePathForSession(sessionId, date = new Date()) {
    const normalizedSessionId = normalizeLlmExecutionSessionId(sessionId);
    const parts = formatCliRolloutPathDateParts(date);
    const fileName = `rollout-${formatCliRolloutFileStamp(date)}-${normalizedSessionId}.jsonl`;
    return path.join(codeCliSessionsDir, parts.year, parts.month, parts.day, fileName);
  }

  function toCliRolloutMessageText(content) {
    const text = String(content || "").trim();
    if (!text) return "";
    return text;
  }

  function normalizeToolStatusLogLabel(rawName) {
    const name = String(rawName || "").trim();
    if (!name) return "unknown_tool";
    if (name === "list_dir") return "search_dir";
    if (name === "find_files") return "find_files";
    if (name === "search_text") return "search_text";
    if (name === "read_file" || name === "read_file_range") return "file_open";
    if (name === "write_file") return "file_write";
    if (name === "edit_file" || name === "apply_patch") return "file_edit";
    if (name === "run_command_sandboxed") return "run_command";
    return name;
  }

  function extractPathForToolStatusLog(argsSummary) {
    if (!argsSummary || typeof argsSummary !== "object") return "";
    return String(argsSummary?.path || "").trim();
  }

  function buildToolStartStatusLogLine(toolName, argsSummary) {
    const label = normalizeToolStatusLogLabel(toolName);
    if (label === "file_open") {
      const filePath = extractPathForToolStatusLog(argsSummary);
      if (filePath) return `file_open : "${filePath}"`;
    }
    return `tool : ${label}`;
  }

  function buildToolErrorStatusLogLine(toolName, errorMessage) {
    const label = normalizeToolStatusLogLabel(toolName);
    const message = String(errorMessage || "").trim();
    if (!message) return `tool_error : ${label}`;
    const compact = message.length > 120 ? `${message.slice(0, 120)}...` : message;
    return `tool_error : ${label} (${compact})`;
  }

  function buildCliSessionMetaPayload(params = {}) {
    const sessionId = normalizeLlmExecutionSessionId(params.sessionId);
    const timestamp = normalizeSessionUpdatedAt(params.timestamp) || new Date().toISOString();
    const cwd = path.resolve(String(params.cwd || workspaceRoot));
    const modelRef = String(params.modelRef || "").trim();
    const reasoningEffort = normalizeReasoningEffort(params.reasoningEffort, { warnInvalid: false });
    const lastReadAt = normalizeSessionUpdatedAt(params.lastReadAt) || timestamp;
    return {
      id: sessionId,
      timestamp,
      cwd,
      originator: cliSessionMetaOriginator,
      cli_version: cliSessionMetaVersion,
      source: cliSessionMetaSource,
      model_provider: "openai",
      model_ref: modelRef,
      reasoning_effort: reasoningEffort || "",
      last_read_at: lastReadAt,
      app_source: "bitty_private_runner",
      git: {},
    };
  }

  function shouldRewriteRunnerSessionMetaPayload(payload, nextPayload) {
    const existingModelRef = String(payload?.model_ref || "").trim();
    const nextModelRef = String(nextPayload?.model_ref || "").trim();
    const existingReasoningEffort = normalizeReasoningEffort(payload?.reasoning_effort, { warnInvalid: false });
    const nextReasoningEffort = normalizeReasoningEffort(nextPayload?.reasoning_effort, { warnInvalid: false });
    if (!nextModelRef && !nextReasoningEffort) return false;
    if (existingModelRef !== nextModelRef) return true;
    if ((existingReasoningEffort || "") !== (nextReasoningEffort || "")) return true;
    return false;
  }

  async function migrateLegacyRunnerSessionMetaIfNeeded(filePath, nextMetaEntry) {
    if (!filePath || !nextMetaEntry || typeof nextMetaEntry !== "object") return;
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return;
    }
    if (!raw) return;
    const lineEndIndex = raw.indexOf("\n");
    const firstLine = (lineEndIndex >= 0 ? raw.slice(0, lineEndIndex) : raw).trim();
    if (!firstLine) return;
    let parsedFirstLine = null;
    try {
      parsedFirstLine = JSON.parse(firstLine);
    } catch {
      return;
    }
    if (String(parsedFirstLine?.type || "") !== "session_meta") return;
    const existingPayload = parsedFirstLine?.payload && typeof parsedFirstLine.payload === "object"
      ? parsedFirstLine.payload
      : null;
    if (!existingPayload) return;
    const existingSessionId = String(existingPayload?.id || "").trim();
    const nextSessionId = String(nextMetaEntry?.payload?.id || "").trim();
    if (!existingSessionId || existingSessionId !== nextSessionId) return;
    const nextPayload = nextMetaEntry?.payload && typeof nextMetaEntry.payload === "object"
      ? nextMetaEntry.payload
      : null;
    if (!nextPayload) return;
    if (!shouldRewriteRunnerSessionMetaPayload(existingPayload, nextPayload)) return;
    const mergedPayload = {
      ...existingPayload,
      model_ref: String(nextPayload?.model_ref || "").trim(),
      reasoning_effort: normalizeReasoningEffort(nextPayload?.reasoning_effort, { warnInvalid: false }) || "",
    };
    const replacementEntry = {
      ...parsedFirstLine,
      payload: mergedPayload,
    };
    const replacementLine = JSON.stringify(replacementEntry);
    const remainder = lineEndIndex >= 0 ? raw.slice(lineEndIndex + 1) : "";
    const nextRaw = `${replacementLine}\n${remainder}`;
    if (nextRaw === raw) return;
    await fs.writeFile(filePath, nextRaw, "utf8");
  }

  async function appendAppConversationToCliRollout(params = {}) {
    const normalizedSessionId = normalizeLlmExecutionSessionId(params.sessionId);
    if (!normalizedSessionId) return;
    const normalizedUserText = toCliRolloutMessageText(params.userText);
    const normalizedAssistantText = toCliRolloutMessageText(params.assistantText);
    const statusLogs = Array.isArray(params.statusLogs)
      ? params.statusLogs.map(toCliRolloutMessageText).filter(Boolean)
      : [];
    const tokenCountPayload = buildTokenCountPayloadFromContextUsage(params.contextUsage);
    if (!normalizedUserText && !normalizedAssistantText && statusLogs.length <= 0 && !tokenCountPayload) return;
    const cwd = path.resolve(String(params.cwd || workspaceRoot));
    const directoryCandidate = String(params.directory || toWorkspaceRelativeFromAbsolutePath(cwd)).trim();
    const directory = directoryCandidate ? normalizeSessionRootRelativePath(directoryCandidate) : "";
    const now = new Date();
    const timestamp = normalizeSessionUpdatedAt(params.updatedAt) || now.toISOString();

    const op = appCliRolloutWriteQueue.then(async () => {
      await ensureCliSessionIndexLoaded();

      let filePath = String(appCliRolloutBySessionId.get(normalizedSessionId) || "").trim();
      if (!filePath) {
        const existing = selectCliSessionIndexEntryBySessionId(normalizedSessionId, { directory });
        if (existing) filePath = String(existing.filePath || "").trim();
      }
      if (!filePath) {
        filePath = buildCliRolloutFilePathForSession(normalizedSessionId, now);
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      let stat = null;
      try {
        stat = await fs.stat(filePath);
      } catch {}
      const needsSessionMeta = !stat || Number(stat.size || 0) <= 0;
      const sessionMetaEntry = {
        timestamp,
        type: "session_meta",
        payload: buildCliSessionMetaPayload({
          sessionId: normalizedSessionId,
          timestamp,
          cwd,
          modelRef: String(params.modelRef || "").trim(),
          reasoningEffort: params.reasoningEffort,
        }),
      };
      if (!needsSessionMeta) {
        await migrateLegacyRunnerSessionMetaIfNeeded(filePath, sessionMetaEntry);
      }

      const lines = [];
      if (needsSessionMeta) {
        lines.push(JSON.stringify(sessionMetaEntry));
      }
      if (normalizedUserText) {
        lines.push(JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: normalizedUserText,
              },
            ],
          },
        }));
        lines.push(JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: {
            type: "user_message",
            message: normalizedUserText,
            images: [],
            local_images: [],
            text_elements: [],
          },
        }));
      }
      for (const statusLog of statusLogs) {
        lines.push(JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "status_log",
            message: statusLog,
          },
        }));
      }
      if (normalizedAssistantText) {
        lines.push(JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: normalizedAssistantText,
            phase: "final_answer",
          },
        }));
        lines.push(JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: normalizedAssistantText,
              },
            ],
            phase: "final_answer",
          },
        }));
      }
      if (tokenCountPayload) {
        lines.push(JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: tokenCountPayload,
        }));
      }
      await fs.appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
      appCliRolloutBySessionId.set(normalizedSessionId, filePath);
      await upsertCliSessionIndexEntryFromRolloutFile(filePath, {
        sessionId: normalizedSessionId,
        cwd,
        directory,
        updatedAt: timestamp,
        lastReadAt: timestamp,
      });
    });
    appCliRolloutWriteQueue = op.catch(() => {});
    await op;
  }

  return {
    appendAppConversationToCliRollout,
    buildToolErrorStatusLogLine,
    buildToolStartStatusLogLine,
  };
}
