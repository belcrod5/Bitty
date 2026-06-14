import { promises as fs } from "node:fs";

export function createLlmSessionRolloutReaders(deps) {
  const {
    makeApiError,
    normalizeReasoningEffort,
    normalizeSessionUpdatedAt,
    normalizeTokenCount,
    parseOpenAICodexModelRef,
    sessionMessagesDefaultLimit,
    sessionMessagesMaxLimit,
    sessionRolloutMaxReadBytes,
    sessionSummaryHeadMaxReadBytes,
    sessionSummaryTailMaxReadBytes,
  } = deps;

  function normalizeSessionMessagesLimit(rawLimit) {
    const value = String(rawLimit ?? "").trim();
    if (!value) return sessionMessagesDefaultLimit;
    if (value.toLowerCase() === "all" || value === "0") return null;
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw makeApiError(400, "invalid_limit", "limit must be a positive integer", {
        max: sessionMessagesMaxLimit,
      });
    }
    return Math.min(sessionMessagesMaxLimit, n);
  }

  function extractSessionMessageTextFromContent(rawContent) {
    if (typeof rawContent === "string") {
      return rawContent.trim();
    }
    const content = Array.isArray(rawContent) ? rawContent : [];
    const chunks = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const type = String(item?.type || "").trim().toLowerCase();
      if (type === "localimage") {
        const localPath = String(item?.path || "").trim();
        if (localPath) chunks.push(`[localImage] ${localPath}`);
        continue;
      }
      const text = String(item?.text || item?.value || "").trim();
      if (!text) continue;
      chunks.push(text);
    }
    if (chunks.length <= 0) return "";
    return chunks.join("\n\n").trim();
  }

  function normalizeSessionMessageRole(rawRole) {
    const role = String(rawRole || "").trim().toLowerCase();
    if (role === "user" || role === "assistant") return role;
    return "";
  }

  function shouldSkipSessionMessage(role, content) {
    const normalizedRole = normalizeSessionMessageRole(role);
    if (!normalizedRole) return true;
    const text = String(content || "").trim();
    if (!text) return true;
    if (normalizedRole === "user") {
      if (text.includes("AGENTS.md instructions for") && text.includes("<INSTRUCTIONS>")) {
        return true;
      }
      if (text.includes("<environment_context>") && text.includes("<cwd>")) {
        return true;
      }
      if (text.includes("<permissions instructions>")) {
        return true;
      }
    }
    return false;
  }

  function buildSessionToolMessageFromCallPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    const toolName = String(payload?.name || payload?.toolName || payload?.tool_name || "").trim();
    if (!toolName) return "";
    return `tool : ${toolName}`;
  }

  function parseSessionMessageFromResponseItem(parsed) {
    if (String(parsed?.type || "") !== "response_item") return null;
    const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
    if (!payload) return null;
    const payloadType = String(payload?.type || "").trim().toLowerCase();
    const at = normalizeSessionUpdatedAt(parsed?.timestamp || payload?.timestamp) || "";
    if (payloadType === "status_log") {
      const content = String(payload?.message || payload?.text || "").trim();
      if (!content || shouldSkipSessionMessage("assistant", content)) return null;
      return {
        role: "assistant",
        content,
        at,
        kind: "status_log",
      };
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const content = buildSessionToolMessageFromCallPayload(payload);
      if (!content || shouldSkipSessionMessage("assistant", content)) return null;
      return {
        role: "assistant",
        content,
        at,
      };
    }
    if (payloadType !== "message") return null;
    const role = normalizeSessionMessageRole(payload?.role);
    if (!role) return null;
    const content = extractSessionMessageTextFromContent(payload?.content);
    if (shouldSkipSessionMessage(role, content)) return null;
    return {
      role,
      content,
      at,
    };
  }

  function parseSessionMessageFromEventItem(parsed) {
    if (String(parsed?.type || "") !== "event_msg") return null;
    const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
    if (!payload) return null;
    const eventType = String(payload?.type || "").trim();
    if (eventType !== "user_message" && eventType !== "agent_message") return null;
    const role = eventType === "user_message" ? "user" : "assistant";
    const content = String(payload?.message || "").trim();
    if (shouldSkipSessionMessage(role, content)) return null;
    const at = normalizeSessionUpdatedAt(parsed?.timestamp || payload?.timestamp) || "";
    return {
      role,
      content,
      at,
    };
  }

  async function readRolloutTextWithByteLimit(filePath, maxBytes) {
    const fileStat = await fs.stat(filePath);
    const size = Number(fileStat.size || 0);
    const start = size > maxBytes ? size - maxBytes : 0;
    const readLength = Math.max(0, size - start);
    if (readLength <= 0) return "";
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, start);
      if (!bytesRead) return "";
      let text = buffer.toString("utf8", 0, bytesRead);
      if (start > 0) {
        const firstLineBreak = text.indexOf("\n");
        if (firstLineBreak >= 0) {
          text = text.slice(firstLineBreak + 1);
        } else {
          text = "";
        }
      }
      return text;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readRolloutHeadTextWithByteLimit(filePath, maxBytes) {
    const fileStat = await fs.stat(filePath);
    const size = Number(fileStat.size || 0);
    const readLength = Math.max(0, Math.min(size, maxBytes));
    if (readLength <= 0) return "";
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
      if (!bytesRead) return "";
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readSessionMessagesFromRolloutFile(filePath, opts = {}) {
    const startedAt = Date.now();
    const limit = opts?.limit === null ? null : normalizeSessionMessagesLimit(opts?.limit);
    let text = "";
    const fileReadStartedAt = Date.now();
    try {
      if (limit === null) {
        text = await fs.readFile(filePath, "utf8");
      } else {
        text = await readRolloutTextWithByteLimit(filePath, sessionRolloutMaxReadBytes);
      }
    } catch (err) {
      if (String(err?.code || "").toUpperCase() === "ENOENT") {
        return {
          messages: [],
          diagnostics: {
            fileReadMs: Math.max(0, Date.now() - fileReadStartedAt),
            lineSplitMs: 0,
            jsonParseMs: 0,
            messageExtractMs: 0,
            limitSliceMs: 0,
            totalMs: Math.max(0, Date.now() - startedAt),
            lineCount: 0,
            parsedLineCount: 0,
          },
        };
      }
      throw err;
    }
    const fileReadMs = Math.max(0, Date.now() - fileReadStartedAt);
    if (!text) {
      return {
        messages: [],
        diagnostics: {
          fileReadMs,
          lineSplitMs: 0,
          jsonParseMs: 0,
          messageExtractMs: 0,
          limitSliceMs: 0,
          totalMs: Math.max(0, Date.now() - startedAt),
          lineCount: 0,
          parsedLineCount: 0,
        },
      };
    }
    const lineSplitStartedAt = Date.now();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const lineSplitMs = Math.max(0, Date.now() - lineSplitStartedAt);
    const responseMessages = [];
    const fallbackEventMessages = [];
    let parsedLineCount = 0;
    const parseStartedAt = Date.now();
    for (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      parsedLineCount += 1;
      const responseMessage = parseSessionMessageFromResponseItem(parsed);
      if (responseMessage) {
        responseMessages.push(responseMessage);
        continue;
      }
      const eventMessage = parseSessionMessageFromEventItem(parsed);
      if (eventMessage) {
        fallbackEventMessages.push(eventMessage);
      }
    }
    const jsonParseMs = Math.max(0, Date.now() - parseStartedAt);
    const extractStartedAt = Date.now();
    const sourceMessages = responseMessages.length > 0 ? responseMessages : fallbackEventMessages;
    const messageExtractMs = Math.max(0, Date.now() - extractStartedAt);
    const sliceStartedAt = Date.now();
    const messages = (limit === null || sourceMessages.length <= limit)
      ? sourceMessages
      : sourceMessages.slice(sourceMessages.length - limit);
    const limitSliceMs = Math.max(0, Date.now() - sliceStartedAt);
    return {
      messages,
      diagnostics: {
        fileReadMs,
        lineSplitMs,
        jsonParseMs,
        messageExtractMs,
        limitSliceMs,
        totalMs: Math.max(0, Date.now() - startedAt),
        lineCount: lines.length,
        parsedLineCount,
      },
    };
  }

  async function readSessionFirstUserMessageFromRolloutFile(filePath, opts = {}) {
    const maxBytes = Math.max(
      16 * 1024,
      Number(opts?.maxBytes || sessionSummaryHeadMaxReadBytes)
    );
    let text = "";
    try {
      text = await readRolloutHeadTextWithByteLimit(filePath, maxBytes);
    } catch (err) {
      if (String(err?.code || "").toUpperCase() === "ENOENT") {
        return "";
      }
      throw err;
    }
    if (!text) return "";
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const responseMessage = parseSessionMessageFromResponseItem(parsed);
      if (responseMessage && responseMessage.role === "user") {
        return String(responseMessage.content || "").trim();
      }
      const eventMessage = parseSessionMessageFromEventItem(parsed);
      if (eventMessage && eventMessage.role === "user") {
        return String(eventMessage.content || "").trim();
      }
    }
    return "";
  }

  function parseSessionMetaFromRolloutText(text, opts = {}) {
    const preferLastTurnContext = opts.preferLastTurnContext === true;
    if (!text) {
      return {
        sessionMetaModelProvider: "",
        sessionMetaModelRef: "",
        sessionMetaReasoningEffort: "",
        turnContextModelRef: "",
        turnContextReasoningEffort: "",
      };
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let sessionMetaModelProvider = "";
    let sessionMetaModelRef = "";
    let sessionMetaReasoningEffort = "";
    let turnContextModelRef = "";
    let turnContextReasoningEffort = "";

    for (const line of lines) {
      if (!line.includes("\"session_meta\"") && !line.includes("\"turn_context\"")) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const type = String(parsed?.type || "").trim();
      if (type === "session_meta") {
        const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : {};
        const modelProvider = String(payload?.model_provider || "").trim().toLowerCase();
        const modelRef = String(payload?.model_ref || "").trim();
        const reasoningEffort = normalizeReasoningEffort(payload?.reasoning_effort, { warnInvalid: false }) || "";
        if (modelProvider && !sessionMetaModelProvider) {
          sessionMetaModelProvider = modelProvider;
        }
        if (modelRef && !sessionMetaModelRef) {
          sessionMetaModelRef = modelRef;
        }
        if (reasoningEffort && !sessionMetaReasoningEffort) {
          sessionMetaReasoningEffort = reasoningEffort;
        }
        continue;
      }
      if (type !== "turn_context") continue;
      const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      const rawModelRef = String(
        payload?.model
        || payload?.collaboration_mode?.settings?.model
        || ""
      ).trim();
      let parsedTurnModelRef = "";
      if (rawModelRef) {
        if (rawModelRef.includes("/")) {
          parsedTurnModelRef = rawModelRef;
        } else if (!sessionMetaModelProvider || sessionMetaModelProvider === "openai") {
          try {
            parsedTurnModelRef = parseOpenAICodexModelRef(rawModelRef).modelRef;
          } catch {
            parsedTurnModelRef = rawModelRef;
          }
        } else {
          parsedTurnModelRef = rawModelRef;
        }
      }
      if (parsedTurnModelRef && (preferLastTurnContext || !turnContextModelRef)) {
        turnContextModelRef = parsedTurnModelRef;
      }
      const parsedTurnReasoningEffort = normalizeReasoningEffort(
        payload?.effort ?? payload?.collaboration_mode?.settings?.reasoning_effort,
        { warnInvalid: false }
      ) || "";
      if (parsedTurnReasoningEffort && (preferLastTurnContext || !turnContextReasoningEffort)) {
        turnContextReasoningEffort = parsedTurnReasoningEffort;
      }
    }

    return {
      sessionMetaModelProvider,
      sessionMetaModelRef,
      sessionMetaReasoningEffort,
      turnContextModelRef,
      turnContextReasoningEffort,
    };
  }

  async function readSessionMetaFromRolloutFile(filePath, opts = {}) {
    const headMaxBytes = Math.max(
      16 * 1024,
      Number(opts?.maxBytes || sessionSummaryHeadMaxReadBytes)
    );
    const tailMaxBytes = Math.max(
      16 * 1024,
      Number(opts?.tailMaxBytes || sessionSummaryTailMaxReadBytes)
    );
    let headText = "";
    try {
      headText = await readRolloutHeadTextWithByteLimit(filePath, headMaxBytes);
    } catch (err) {
      if (String(err?.code || "").toUpperCase() === "ENOENT") {
        return { modelRef: "", reasoningEffort: "" };
      }
      throw err;
    }
    if (!headText) return { modelRef: "", reasoningEffort: "" };

    const headMeta = parseSessionMetaFromRolloutText(headText, { preferLastTurnContext: false });

    let rolloutFileSize = 0;
    try {
      const stat = await fs.stat(filePath);
      rolloutFileSize = Number(stat?.size || 0);
    } catch {}

    const maxTailSearchBytes = Math.max(
      tailMaxBytes,
      Math.min(
        Math.max(tailMaxBytes, Number(opts?.tailSearchMaxBytes || sessionRolloutMaxReadBytes)),
        rolloutFileSize || 0
      )
    );
    const parseTailMeta = async (readBytes) => {
      let tailText = "";
      try {
        tailText = await readRolloutTextWithByteLimit(filePath, readBytes);
      } catch {
        return parseSessionMetaFromRolloutText("", { preferLastTurnContext: true });
      }
      return parseSessionMetaFromRolloutText(tailText, { preferLastTurnContext: true });
    };

    let tailReadBytes = tailMaxBytes;
    let tailMeta = await parseTailMeta(tailReadBytes);
    while (
      (rolloutFileSize > tailReadBytes)
      && (tailReadBytes < maxTailSearchBytes)
      && !tailMeta.turnContextModelRef
      && !tailMeta.turnContextReasoningEffort
    ) {
      tailReadBytes = Math.min(maxTailSearchBytes, tailReadBytes * 2);
      tailMeta = await parseTailMeta(tailReadBytes);
    }

    const sessionMetaModelRef = headMeta.sessionMetaModelRef || tailMeta.sessionMetaModelRef;
    const sessionMetaReasoningEffort = (
      headMeta.sessionMetaReasoningEffort || tailMeta.sessionMetaReasoningEffort
    );
    const turnContextModelRef = tailMeta.turnContextModelRef || headMeta.turnContextModelRef;
    const turnContextReasoningEffort = (
      tailMeta.turnContextReasoningEffort || headMeta.turnContextReasoningEffort
    );

    if (!sessionMetaModelRef && !sessionMetaReasoningEffort && !turnContextModelRef && !turnContextReasoningEffort) {
      return { modelRef: "", reasoningEffort: "" };
    }

    return {
      modelRef: turnContextModelRef || sessionMetaModelRef,
      reasoningEffort: turnContextReasoningEffort || sessionMetaReasoningEffort,
    };
  }

  function parseSessionContextUsageFromTokenCountPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (String(payload?.type || "").trim() !== "token_count") return null;
    const info = payload?.info && typeof payload.info === "object" ? payload.info : null;
    if (!info) return null;
    const lastUsage = info?.last_token_usage && typeof info.last_token_usage === "object"
      ? info.last_token_usage
      : null;
    if (!lastUsage) return null;
    const contextWindowTokens = normalizeTokenCount(info?.model_context_window);
    if (contextWindowTokens <= 0) return null;
    const inputTokens = normalizeTokenCount(lastUsage?.input_tokens);
    const outputTokens = normalizeTokenCount(lastUsage?.output_tokens);
    const totalTokens = normalizeTokenCount(lastUsage?.total_tokens) || Math.max(0, inputTokens + outputTokens);
    if (totalTokens <= 0) return null;
    const cachedInputTokens = normalizeTokenCount(lastUsage?.cached_input_tokens);
    const reasoningOutputTokens = normalizeTokenCount(lastUsage?.reasoning_output_tokens);
    const usedRatio = Math.max(0, Math.min(1, totalTokens / contextWindowTokens));
    const usedPct = Math.max(0, Math.min(100, Math.round(usedRatio * 100)));
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      contextWindowTokens,
      usedRatio,
      usedPct,
    };
  }

  function normalizeContextUsageSnapshot(rawUsage) {
    if (!rawUsage || typeof rawUsage !== "object") return null;
    const inputTokens = normalizeTokenCount(rawUsage?.inputTokens ?? rawUsage?.input_tokens);
    const outputTokens = normalizeTokenCount(rawUsage?.outputTokens ?? rawUsage?.output_tokens);
    const totalTokens = normalizeTokenCount(rawUsage?.totalTokens ?? rawUsage?.total_tokens)
      || Math.max(0, inputTokens + outputTokens);
    const cachedInputTokens = normalizeTokenCount(rawUsage?.cachedInputTokens ?? rawUsage?.cached_input_tokens);
    const reasoningOutputTokens = normalizeTokenCount(rawUsage?.reasoningOutputTokens ?? rawUsage?.reasoning_output_tokens);
    const contextWindowTokens = normalizeTokenCount(
      rawUsage?.contextWindowTokens
      ?? rawUsage?.context_window_tokens
      ?? rawUsage?.context_window
      ?? rawUsage?.modelContextWindow
      ?? rawUsage?.model_context_window
    );
    if (totalTokens <= 0 || contextWindowTokens <= 0) return null;
    const rawUsedRatio = Number(rawUsage?.usedRatio ?? rawUsage?.used_ratio);
    const usedRatio = Number.isFinite(rawUsedRatio)
      ? Math.max(0, Math.min(1, rawUsedRatio))
      : Math.max(0, Math.min(1, totalTokens / contextWindowTokens));
    const rawUsedPct = Number(rawUsage?.usedPct ?? rawUsage?.used_pct);
    const usedPct = Number.isFinite(rawUsedPct)
      ? Math.max(0, Math.min(100, Math.round(rawUsedPct)))
      : Math.max(0, Math.min(100, Math.round(usedRatio * 100)));
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      contextWindowTokens,
      usedRatio,
      usedPct,
    };
  }

  function buildTokenCountPayloadFromContextUsage(rawUsage) {
    const usage = normalizeContextUsageSnapshot(rawUsage);
    if (!usage) return null;
    const tokenUsage = {
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      output_tokens: usage.outputTokens,
      reasoning_output_tokens: usage.reasoningOutputTokens,
      total_tokens: usage.totalTokens,
    };
    return {
      type: "token_count",
      info: {
        total_token_usage: tokenUsage,
        last_token_usage: tokenUsage,
        model_context_window: usage.contextWindowTokens,
      },
    };
  }

  async function readSessionContextUsageFromRolloutFile(filePath, opts = {}) {
    const maxBytes = Math.max(
      16 * 1024,
      Number(opts?.maxBytes || sessionRolloutMaxReadBytes)
    );
    let text = "";
    try {
      text = await readRolloutTextWithByteLimit(filePath, maxBytes);
    } catch (err) {
      if (String(err?.code || "").toUpperCase() === "ENOENT") {
        return null;
      }
      throw err;
    }
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let parsed = null;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (String(parsed?.type || "").trim() !== "event_msg") continue;
      const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
      const contextUsage = parseSessionContextUsageFromTokenCountPayload(payload);
      if (contextUsage) return contextUsage;
    }
    return null;
  }

  async function readCliSessionSummaryFromRolloutFile(filePath) {
    const [firstUserMessage, contextUsage, meta] = await Promise.all([
      readSessionFirstUserMessageFromRolloutFile(filePath, {
        maxBytes: sessionSummaryHeadMaxReadBytes,
      }),
      readSessionContextUsageFromRolloutFile(filePath, {
        maxBytes: sessionSummaryTailMaxReadBytes,
      }),
      readSessionMetaFromRolloutFile(filePath, {
        maxBytes: sessionSummaryHeadMaxReadBytes,
      }),
    ]);
    return {
      firstUserMessage: String(firstUserMessage || "").trim(),
      contextUsage: contextUsage || null,
      modelRef: String(meta?.modelRef || "").trim(),
      reasoningEffort: String(meta?.reasoningEffort || "").trim(),
    };
  }

  return {
    buildTokenCountPayloadFromContextUsage,
    normalizeSessionMessagesLimit,
    readCliSessionSummaryFromRolloutFile,
    readSessionContextUsageFromRolloutFile,
    readSessionMetaFromRolloutFile,
    readSessionMessagesFromRolloutFile,
  };
}
