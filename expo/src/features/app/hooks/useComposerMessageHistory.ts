import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMPOSER_MESSAGE_HISTORY_FIELD,
  mutatePersistedSettings,
  readPersistedSettingsField,
} from "../utils/persistedSettingsFile";

export const COMPOSER_MESSAGE_HISTORY_LIMIT = 20;

export function parseComposerMessageHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is string => typeof message === "string")
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(0, COMPOSER_MESSAGE_HISTORY_LIMIT);
}

export function useComposerMessageHistory() {
  const [messages, setMessages] = useState<string[]>([]);
  const revisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    const revision = revisionRef.current;
    void readPersistedSettingsField(COMPOSER_MESSAGE_HISTORY_FIELD)
      .then((value) => {
        if (active && revision === revisionRef.current) {
          setMessages(parseComposerMessageHistory(value));
        }
      })
      .catch((error) => {
        console.warn("[composer-history] failed to load message history", error);
      });
    return () => {
      active = false;
    };
  }, []);

  const recordMessage = useCallback((messageRaw: string) => {
    const message = String(messageRaw || "").trim();
    if (!message) return;
    revisionRef.current += 1;
    setMessages((current) => [message, ...current].slice(0, COMPOSER_MESSAGE_HISTORY_LIMIT));
    void mutatePersistedSettings((current) => {
      const history = parseComposerMessageHistory(current[COMPOSER_MESSAGE_HISTORY_FIELD]);
      return {
        ...current,
        [COMPOSER_MESSAGE_HISTORY_FIELD]: [message, ...history].slice(
          0,
          COMPOSER_MESSAGE_HISTORY_LIMIT
        ),
      };
    }).catch((error) => {
      console.warn("[composer-history] failed to save message history", error);
    });
  }, []);

  return { messages, recordMessage };
}
