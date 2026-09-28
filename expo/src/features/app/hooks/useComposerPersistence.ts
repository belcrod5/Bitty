import { useEffect, useRef } from "react";

export const COMPOSER_MESSAGE_HISTORY_LIMIT = 40;
export const COMPOSER_DRAFT_LIMIT = 10;

export type ComposerDraft = {
  backendId?: string;
  sessionId: string;
  text: string;
  updatedAt: number;
};

export function parseComposerMessageHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is string => typeof message === "string")
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(0, COMPOSER_MESSAGE_HISTORY_LIMIT);
}

export function parseComposerDrafts(value: unknown): ComposerDraft[] {
  if (!Array.isArray(value)) return [];
  const newestBySession = new Map<string, ComposerDraft>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const text = typeof raw.text === "string" ? raw.text : "";
    const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Number.NaN;
    if (!sessionId || !text.trim() || !Number.isFinite(updatedAt) || updatedAt <= 0) continue;
    const existing = newestBySession.get(sessionId);
    if (!existing || updatedAt > existing.updatedAt) {
      newestBySession.set(sessionId, { sessionId, text, updatedAt });
    }
  }
  return Array.from(newestBySession.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, COMPOSER_DRAFT_LIMIT);
}

export function useComposerDraftSync(options: {
  backendId?: string;
  scopeId?: string;
  sessionId: string;
  text: string;
  drafts: readonly ComposerDraft[];
  loaded: boolean;
  enabled?: boolean;
  setText: (text: string) => void;
  setDraft: (sessionId: string, text: string, backendId?: string) => void;
}) {
  const { backendId, scopeId, sessionId: sessionIdRaw, text, drafts, loaded, enabled = true, setText, setDraft } = options;
  const previousScopeRef = useRef(scopeId);
  const bindingRef = useRef<{
    sessionId: string;
    observedText: string;
    pendingDraftText: string | null;
  } | null>(null);

  useEffect(() => {
    if (previousScopeRef.current !== scopeId) {
      previousScopeRef.current = scopeId;
      bindingRef.current = null;
      if (text) setText("");
      return;
    }
    const sessionId = String(sessionIdRaw || "").trim();
    if (!enabled || !sessionId) {
      bindingRef.current = null;
      return;
    }

    const identity = `${scopeId || ""}\u0000${backendId || "codex"}\u0000${sessionId}`;
    let binding = bindingRef.current;
    if (!binding || binding.sessionId !== identity) {
      binding = { sessionId: identity, observedText: text, pendingDraftText: null };
      bindingRef.current = binding;
    }

    if (text !== binding.observedText) {
      binding.observedText = text;
      binding.pendingDraftText = text;
      if (backendId) setDraft(sessionId, text, backendId);
      else setDraft(sessionId, text);
      return;
    }

    if (!loaded) return;
    const persistedText = drafts.find((draft) => draft.sessionId === sessionId
      && (!backendId || (draft.backendId || "codex") === backendId))?.text
      ?? drafts.find((draft) => draft.sessionId === sessionId && draft.backendId === "legacy")?.text
      ?? "";
    if (binding.pendingDraftText !== null) {
      if (persistedText === binding.pendingDraftText) binding.pendingDraftText = null;
      return;
    }
    if (persistedText === text) return;
    binding.observedText = persistedText;
    setText(persistedText);
  }, [backendId, scopeId, drafts, enabled, loaded, sessionIdRaw, setDraft, setText, text]);
}
