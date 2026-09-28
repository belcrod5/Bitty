import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, AppState } from "react-native";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import { mutatePersistedSettings, readPersistedSettings } from "../utils/persistedSettingsFile";
import { requestRunnerClientState, runnerSessionKey, type RunnerClientState } from "../utils/runnerClientState";
import { parseComposerDrafts, parseComposerMessageHistory, type ComposerDraft } from "./useComposerPersistence";

type Options = {
  settingsLoaded: boolean;
  runnerUrl: string;
  runnerToken: string;
  backendId: string;
  parseRegisteredDirectories: (value: unknown) => RegisteredDirectoryEntry[];
  setRegisteredDirectories: Dispatch<SetStateAction<RegisteredDirectoryEntry[]>>;
  setSessionTitleOverridesById: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMarkerColorsById: Dispatch<SetStateAction<Record<string, RegisteredDirectoryEntry["markerColor"]>>>;
};

const LEGACY_FIELDS = ["registeredDirectories", "sessionTitleOverridesById", "sessionMarkerColorsById", "composerMessageHistory", "composerDrafts"];

export function useRunnerClientState({
  settingsLoaded, runnerUrl, runnerToken, backendId,
  parseRegisteredDirectories,
  setRegisteredDirectories, setSessionTitleOverridesById, setSessionMarkerColorsById,
}: Options) {
  const [messages, setMessages] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ComposerDraft[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const snapshotRef = useRef<RunnerClientState | null>(null);
  const connectionRef = useRef({ runnerUrl, runnerToken, backendId });
  connectionRef.current = { runnerUrl, runnerToken, backendId };
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDrafts = useRef<Record<string, string>>({});

  const applySnapshot = useCallback((snapshot: RunnerClientState) => {
    snapshotRef.current = snapshot;
    setRegisteredDirectories(snapshot.directories);
    setSessionTitleOverridesById(Object.fromEntries(Object.entries(snapshot.sessions)
      .filter(([, value]) => value.title)
      .map(([key, value]) => [key, value.title])));
    setSessionMarkerColorsById(Object.fromEntries(Object.entries(snapshot.sessions)
      .filter(([, value]) => value.markerColor !== "none")
      .map(([key, value]) => [key, value.markerColor])));
    setMessages(snapshot.composerHistory);
    for (const [key, text] of Object.entries(pendingDrafts.current)) {
      if ((snapshot.drafts[key]?.text || "") === text) delete pendingDrafts.current[key];
    }
    setDrafts(Object.entries({ ...snapshot.drafts, ...Object.fromEntries(Object.entries(pendingDrafts.current)
      .filter(([, text]) => text.trim())
      .map(([key, text]) => [key, { text, updatedAt: Date.now() }])) }).map(([key, value]) => {
      const [backendId, sessionId] = JSON.parse(key) as [string, string];
      return { backendId, sessionId, text: value.text, updatedAt: value.updatedAt };
    }).filter((draft) => pendingDrafts.current[runnerSessionKey(draft.backendId, draft.sessionId)] !== ""));
    setDraftsLoaded(true);
  }, [setRegisteredDirectories, setSessionMarkerColorsById, setSessionTitleOverridesById]);

  const refresh = useCallback(async () => {
    const { runnerUrl: url, runnerToken: token } = connectionRef.current;
    if (!url || !token) return;
    let snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token });
    let migrated = false;
    if (snapshot.revision === 0) {
      const legacy = await readPersistedSettings();
      const hasLegacyData = legacy && (
        parseComposerMessageHistory(legacy.composerMessageHistory).length > 0
        || parseComposerDrafts(legacy.composerDrafts).length > 0
        || (Array.isArray(legacy.registeredDirectories) && legacy.registeredDirectories.length > 0)
        || Object.keys(legacy.sessionTitleOverridesById || {}).length > 0
        || Object.keys(legacy.sessionMarkerColorsById || {}).length > 0
      );
      if (legacy && hasLegacyData) {
        const legacyBackendId = legacy.llmBackend === "claude" ? "claude" : "codex";
        const sessions: Record<string, { title?: string; markerColor?: string }> = {};
        const titles = legacy.sessionTitleOverridesById as Record<string, string> || {};
        const colors = legacy.sessionMarkerColorsById as Record<string, string> || {};
        for (const sessionId of new Set([...Object.keys(titles), ...Object.keys(colors)])) {
          sessions[runnerSessionKey(legacyBackendId, sessionId)] = { title: titles[sessionId], markerColor: colors[sessionId] };
        }
        const drafts: Record<string, { text: string }> = {};
        for (const draft of parseComposerDrafts(legacy.composerDrafts)) {
          drafts[runnerSessionKey(legacyBackendId, draft.sessionId)] = { text: draft.text };
        }
        snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation: {
          type: "migrate", directories: parseRegisteredDirectories(legacy.registeredDirectories), sessions,
          composerHistory: parseComposerMessageHistory(legacy.composerMessageHistory), drafts,
        } });
        migrated = snapshot.migrationApplied === true;
      }
    }
    applySnapshot(snapshot);
    for (const [key, text] of Object.entries(pendingDrafts.current)) {
      if (draftTimers.current[key]) continue;
      const [draftBackendId, sessionId] = JSON.parse(key) as [string, string];
      snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation: {
        type: "draft.set", backendId: draftBackendId, sessionId, text,
      } });
      applySnapshot(snapshot);
    }
    if (migrated) {
      // Remove old device-authoritative fields only after a successful Runner read/write.
      await mutatePersistedSettings((current) => {
        const next = { ...current };
        for (const field of LEGACY_FIELDS) delete next[field];
        return next;
      });
    }
  }, [applySnapshot, parseRegisteredDirectories]);

  const enqueue = useCallback((operation?: Record<string, unknown>) => {
    const next = queue.current.then(async () => {
      if (!snapshotRef.current || !operation) await refresh();
      if (!operation) return;
      const { runnerUrl: url, runnerToken: token } = connectionRef.current;
      if (!url || !token) throw new Error("Runner connection is not configured");
      applySnapshot(await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation }));
    });
    queue.current = next.catch(() => {});
    return next;
  }, [applySnapshot, refresh]);

  useEffect(() => {
    if (!settingsLoaded || !runnerToken) return;
    snapshotRef.current = null;
    void enqueue().catch((error) => console.warn("[client-state] failed to load", error));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void enqueue().catch((error) => console.warn("[client-state] failed to refresh", error));
    });
    const poll = setInterval(() => {
      if (AppState.currentState === "active") void enqueue().catch((error) => console.warn("[client-state] failed to refresh", error));
    }, 15_000);
    return () => {
      subscription.remove();
      clearInterval(poll);
    };
  }, [enqueue, runnerToken, runnerUrl, settingsLoaded]);

  const mutate = useCallback((operation: Record<string, unknown>) => {
    void enqueue(operation).catch((error) => Alert.alert("Runner に保存できません", error instanceof Error ? error.message : String(error)));
  }, [enqueue]);

  const recordMessage = useCallback((text: string) => {
    const message = String(text || "").trim();
    if (!message) return;
    setMessages((current) => [message, ...current].slice(0, 40));
    mutate({ type: "composer.append", text: message });
  }, [mutate]);

  const setDraft = useCallback((sessionId: string, text: string, backendId = connectionRef.current.backendId) => {
    if (!sessionId) return;
    const nextText = String(text ?? "");
    const key = runnerSessionKey(backendId, sessionId);
    pendingDrafts.current[key] = nextText;
    setDrafts((current) => [
      ...(nextText.trim() ? [{ backendId, sessionId, text: nextText, updatedAt: Date.now() }] : []),
      ...current.filter((draft) => draft.backendId !== backendId || draft.sessionId !== sessionId),
    ].slice(0, 10));
    if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
    draftTimers.current[key] = setTimeout(() => {
      delete draftTimers.current[key];
      mutate({ type: "draft.set", backendId, sessionId, text: nextText });
    }, 300);
  }, [mutate]);

  const clearDraft = useCallback((sessionId: string, backendId = connectionRef.current.backendId) => {
    const key = runnerSessionKey(backendId, sessionId);
    if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
    delete draftTimers.current[key];
    pendingDrafts.current[key] = "";
    setDrafts((current) => current.filter((draft) => draft.backendId !== backendId || draft.sessionId !== sessionId));
    mutate({ type: "draft.set", backendId, sessionId, text: "" });
  }, [mutate]);

  useEffect(() => {
    const flush = () => {
      for (const key of Object.keys(draftTimers.current)) {
        clearTimeout(draftTimers.current[key]);
        delete draftTimers.current[key];
        const [draftBackendId, sessionId] = JSON.parse(key) as [string, string];
        mutate({ type: "draft.set", backendId: draftBackendId, sessionId, text: pendingDrafts.current[key] });
      }
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [mutate]);

  return { mutate, messages, recordMessage, drafts, draftsLoaded, setDraft, clearDraft };
}
