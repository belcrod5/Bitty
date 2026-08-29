import { createHash } from "node:crypto";

import { ALL_BACKENDS_SCOPE, agentError, normalizeAgentSessionRef } from "./agent-protocol.mjs";

export const CONVERSATION_SEARCH_LIMIT = 20;
export const CONVERSATION_SEARCH_SNIPPET_CHARS = 320;
export const CONVERSATION_SEARCH_SCAN_ITEMS = 400;
export const CONVERSATION_SEARCH_SCAN_SESSIONS = 40;
export const CONVERSATION_SEARCH_SCAN_PAGES = 40;
export const CONVERSATION_HISTORY_PAGE_ITEMS = 50;
export const CONVERSATION_READ_LIMIT = 50;
export const CONVERSATION_READ_MAX_CHARS = 12_000;
export const CONVERSATION_FOCUSED_READ_MAX_CHARS = 2_400;
export const CONVERSATION_READ_SCAN_ITEMS = 200;
export const CONVERSATION_READ_SCAN_PAGES = 20;

const CURSOR_VERSION = 2;
const MAX_CURSOR_CHARS = 4096;
const MAX_CWDS = 8;

function requiredText(value, name, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw agentError("turn_rejected", `${name} is required`);
  if (text.length > maxLength) throw agentError("turn_rejected", `${name} is too long`);
  return text;
}

function normalizedLimit(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw agentError("turn_rejected", `limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function normalizedCursor(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > MAX_CURSOR_CHARS) {
    throw agentError("history_cursor_invalid", "conversation history cursor is invalid");
  }
  return value;
}

function normalizedSearchOrder(value) {
  if (value === undefined || value === null || value === "") return "";
  const order = String(value).trim().toLowerCase();
  if (order !== "newest" && order !== "oldest") {
    throw agentError("turn_rejected", "order must be newest or oldest");
  }
  return order;
}

function normalizedSince(value) {
  if (value === undefined || value === null || value === "") return "";
  const since = String(value).trim();
  const timestamp = Date.parse(since);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(since) || !Number.isFinite(timestamp)) {
    throw agentError("turn_rejected", "since must be a valid ISO timestamp");
  }
  return new Date(timestamp).toISOString();
}

export function normalizeConversationSearchOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw agentError("turn_rejected", "history search options must be an object");
  }
  const rawCwds = Array.isArray(options.cwds)
    ? options.cwds
    : options.cwd === undefined ? [] : [options.cwd];
  if (rawCwds.length < 1 || rawCwds.length > MAX_CWDS) {
    throw agentError("turn_rejected", `cwds must contain between 1 and ${MAX_CWDS} workspaces`);
  }
  return {
    query: requiredText(options.query, "query", 512),
    cwds: rawCwds.map((cwd, index) => requiredText(cwd, `cwds[${index}]`, 4096)),
    backendId: options.backendId === undefined || options.backendId === ""
      ? ALL_BACKENDS_SCOPE
      : requiredText(options.backendId, "backendId", 64),
    limit: normalizedLimit(options.limit, 10, CONVERSATION_SEARCH_LIMIT),
    cursor: normalizedCursor(options.cursor),
    order: normalizedSearchOrder(options.order),
    since: normalizedSince(options.since),
  };
}

export function normalizeConversationReadOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw agentError("turn_rejected", "conversation history options must be an object");
  }
  return {
    sessionRef: normalizeAgentSessionRef(options.sessionRef),
    limit: normalizedLimit(options.limit, 20, CONVERSATION_READ_LIMIT),
    cursor: normalizedCursor(options.cursor),
  };
}

export function conversationItem(item) {
  const role = String(item?.role || "").trim().toLowerCase();
  if ((role !== "user" && role !== "assistant") || String(item?.itemType || "").trim()) return null;
  const text = (Array.isArray(item?.content) ? item.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  if (!text) return null;
  return {
    id: String(item?.id || "").slice(0, 1024),
    role,
    text,
    ...(item?.createdAt ? { createdAt: String(item.createdAt).slice(0, 64) } : {}),
  };
}

export function conversationItems(items) {
  return (Array.isArray(items) ? items : []).map(conversationItem).filter(Boolean);
}

function searchableText(value, includeOffsets = false) {
  const source = String(value || "");
  let text = "";
  const offsets = [];
  let pendingSpace = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/u.test(character)) {
      if (text && pendingSpace < 0) pendingSpace = index;
      continue;
    }
    if (pendingSpace >= 0) {
      text += " ";
      if (includeOffsets) offsets.push(pendingSpace);
      pendingSpace = -1;
    }
    const normalized = character.toLowerCase();
    text += normalized;
    if (includeOffsets) {
      for (let offset = 0; offset < normalized.length; offset += 1) offsets.push(index);
    }
  }
  return { text, offsets };
}

export function conversationMatch(text, query) {
  const source = String(text || "");
  const searchable = searchableText(source, true);
  const needle = searchableText(query).text;
  const matchAt = needle ? searchable.text.indexOf(needle) : -1;
  if (matchAt < 0) return "";
  const sourceStart = searchable.offsets[matchAt];
  const sourceEnd = searchable.offsets[matchAt + needle.length - 1] + 1;
  const compact = source.replace(/\s+/gu, " ").trim();
  const compactMatchAt = searchable.text.indexOf(needle);
  const context = Math.floor((CONVERSATION_SEARCH_SNIPPET_CHARS - needle.length) / 2);
  let start = Math.max(0, compactMatchAt - Math.max(0, context));
  let end = Math.min(compact.length, start + CONVERSATION_SEARCH_SNIPPET_CHARS);
  start = Math.max(0, end - CONVERSATION_SEARCH_SNIPPET_CHARS);
  let snippet = compact.slice(start, end);
  if (start > 0) snippet = `…${snippet.slice(1)}`;
  if (end < compact.length) snippet = `${snippet.slice(0, -1)}…`;
  return { snippet, start: sourceStart, end: sourceEnd };
}

export function focusedConversationItem(item, focus) {
  if (!item || !focus || !Number.isInteger(focus.start) || !Number.isInteger(focus.end)
    || focus.start < 0 || focus.end <= focus.start || focus.end > item.text.length
    || focus.end - focus.start > CONVERSATION_FOCUSED_READ_MAX_CHARS) {
    throw agentError("history_cursor_invalid", "conversation history focus is invalid");
  }
  const context = Math.floor((CONVERSATION_FOCUSED_READ_MAX_CHARS - (focus.end - focus.start)) / 2);
  let sectionStart = Math.max(0, focus.start - context);
  let sectionEnd = Math.min(item.text.length, sectionStart + CONVERSATION_FOCUSED_READ_MAX_CHARS);
  sectionStart = Math.max(0, sectionEnd - CONVERSATION_FOCUSED_READ_MAX_CHARS);
  return {
    ...item,
    text: item.text.slice(sectionStart, sectionEnd),
    sectionStart,
    sectionEnd,
    focusStart: focus.start - sectionStart,
    focusEnd: focus.end - sectionStart,
    ...(sectionStart > 0 ? { truncatedStart: true } : {}),
    ...(sectionEnd < item.text.length ? { truncatedEnd: true } : {}),
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function conversationCursorSignature(value) {
  return hash(JSON.stringify(value));
}

export function conversationPageFingerprint(items) {
  return hash(items.map((item) => `${item.id}\u0000${item.role}\u0000${item.text}`).join("\u0001"));
}

export function encodeConversationCursor(value) {
  const cursor = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...value })).toString("base64url");
  if (cursor.length > MAX_CURSOR_CHARS) {
    throw agentError("output_limit_exceeded", "conversation history cursor is too large");
  }
  return cursor;
}

export function decodeConversationCursor(raw, kind, signature) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed?.v !== CURSOR_VERSION || parsed?.kind !== kind || parsed?.signature !== signature) {
      throw new Error("cursor mismatch");
    }
    return parsed;
  } catch {
    throw agentError("history_cursor_invalid", "conversation history cursor is invalid");
  }
}
