import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  COMPOSER_DRAFTS_FIELD,
  COMPOSER_MESSAGE_HISTORY_FIELD,
  mutatePersistedSettings,
  readPersistedSettingsField,
} from "../utils/persistedSettingsFile";

export const COMPOSER_MESSAGE_HISTORY_LIMIT = 40;
export const COMPOSER_DRAFT_LIMIT = 10;
const DRAFT_SAVE_DELAY_MS = 300;

export type ComposerDraft = {
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

export function useComposerPersistence() {
  const [messages, setMessages] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ComposerDraft[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const historyRevisionRef = useRef(0);
  const draftsRef = useRef<ComposerDraft[]>([]);
  const draftsLoadedRef = useRef(false);
  const dirtyDraftSessionIdsRef = useRef(new Set<string>());
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistDrafts = useCallback((nextDrafts: ComposerDraft[]) => {
    void mutatePersistedSettings((current) => ({
      ...current,
      [COMPOSER_DRAFTS_FIELD]: parseComposerDrafts(nextDrafts),
    })).catch((error) => {
      console.warn("[composer-drafts] failed to save drafts", error);
    });
  }, []);

  const flushDrafts = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    if (draftsLoadedRef.current || dirtyDraftSessionIdsRef.current.size > 0) {
      persistDrafts(draftsRef.current);
    }
  }, [persistDrafts]);

  const scheduleDraftSave = useCallback(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      persistDrafts(draftsRef.current);
    }, DRAFT_SAVE_DELAY_MS);
  }, [persistDrafts]);

  useEffect(() => {
    let active = true;
    const historyRevision = historyRevisionRef.current;
    void Promise.all([
      readPersistedSettingsField(COMPOSER_MESSAGE_HISTORY_FIELD),
      readPersistedSettingsField(COMPOSER_DRAFTS_FIELD),
    ]).then(([historyValue, draftValue]) => {
      if (!active) return;
      if (historyRevision === historyRevisionRef.current) {
        setMessages(parseComposerMessageHistory(historyValue));
      }
      const dirtyIds = dirtyDraftSessionIdsRef.current;
      const merged = parseComposerDrafts([
        ...draftsRef.current,
        ...parseComposerDrafts(draftValue).filter((draft) => !dirtyIds.has(draft.sessionId)),
      ]);
      draftsRef.current = merged;
      setDrafts(merged);
      draftsLoadedRef.current = true;
      setDraftsLoaded(true);
    }).catch((error) => {
      console.warn("[composer] failed to load persisted state", error);
      if (active) {
        draftsLoadedRef.current = true;
        setDraftsLoaded(true);
      }
    });
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") flushDrafts();
    });
    return () => {
      active = false;
      subscription.remove();
      flushDrafts();
    };
  }, [flushDrafts]);

  const recordMessage = useCallback((messageRaw: string) => {
    const message = String(messageRaw || "").trim();
    if (!message) return;
    historyRevisionRef.current += 1;
    setMessages((current) => [message, ...current].slice(0, COMPOSER_MESSAGE_HISTORY_LIMIT));
    void mutatePersistedSettings((current) => {
      const history = parseComposerMessageHistory(current[COMPOSER_MESSAGE_HISTORY_FIELD]);
      return {
        ...current,
        [COMPOSER_MESSAGE_HISTORY_FIELD]: [message, ...history].slice(0, COMPOSER_MESSAGE_HISTORY_LIMIT),
      };
    }).catch((error) => {
      console.warn("[composer-history] failed to save message history", error);
    });
  }, []);

  const setDraft = useCallback((sessionIdRaw: string, textRaw: string) => {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return;
    const text = String(textRaw ?? "");
    dirtyDraftSessionIdsRef.current.add(sessionId);
    const next = parseComposerDrafts([
      ...(text.trim() ? [{ sessionId, text, updatedAt: Date.now() }] : []),
      ...draftsRef.current.filter((draft) => draft.sessionId !== sessionId),
    ]);
    draftsRef.current = next;
    setDrafts(next);
    scheduleDraftSave();
  }, [scheduleDraftSave]);

  const clearDraft = useCallback((sessionIdRaw: string) => {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return;
    dirtyDraftSessionIdsRef.current.add(sessionId);
    const next = draftsRef.current.filter((draft) => draft.sessionId !== sessionId);
    draftsRef.current = next;
    setDrafts(next);
    flushDrafts();
  }, [flushDrafts]);

  return { messages, recordMessage, drafts, draftsLoaded, setDraft, clearDraft };
}

export function useComposerDraftSync(options: {
  sessionId: string;
  text: string;
  drafts: readonly ComposerDraft[];
  loaded: boolean;
  enabled?: boolean;
  setText: (text: string) => void;
  setDraft: (sessionId: string, text: string) => void;
}) {
  const { sessionId: sessionIdRaw, text, drafts, loaded, enabled = true, setText, setDraft } = options;
  const bindingRef = useRef<{
    sessionId: string;
    observedText: string;
    restored: boolean;
  } | null>(null);

  useEffect(() => {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!enabled || !sessionId) {
      bindingRef.current = null;
      return;
    }

    let binding = bindingRef.current;
    if (!binding || binding.sessionId !== sessionId) {
      binding = { sessionId, observedText: text, restored: false };
      bindingRef.current = binding;
    }

    if (text !== binding.observedText) {
      binding.observedText = text;
      binding.restored = true;
      setDraft(sessionId, text);
      return;
    }

    if (!loaded || binding.restored) return;
    const persistedText = drafts.find((draft) => draft.sessionId === sessionId)?.text || "";
    binding.restored = true;
    if (persistedText === text) return;
    binding.observedText = persistedText;
    setText(persistedText);
  }, [drafts, enabled, loaded, sessionIdRaw, setDraft, setText, text]);
}
