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
type Connection = { runnerUrl: string; runnerToken: string; backendId: string };
const connectionId = ({ runnerUrl, runnerToken }: Connection) => JSON.stringify([runnerUrl, runnerToken]);

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
  const snapshotConnectionRef = useRef("");
  const connectionRef = useRef({ runnerUrl, runnerToken, backendId });
  connectionRef.current = { runnerUrl, runnerToken, backendId };
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const queuedDrafts = useRef(new Set<string>());
  const pendingDrafts = useRef<Record<string, { text: string; connection: Connection }>>({});

  const applySnapshot = useCallback((snapshot: RunnerClientState, connection: Connection) => {
    const id = connectionId(connection);
    if (id !== connectionId(connectionRef.current)) return;
    if (snapshotConnectionRef.current === id && snapshotRef.current?.revision === snapshot.revision) return;
    snapshotConnectionRef.current = id;
    snapshotRef.current = snapshot;
    setRegisteredDirectories((current) => JSON.stringify(current) === JSON.stringify(snapshot.directories) ? current : snapshot.directories);
    setSessionTitleOverridesById(Object.fromEntries(Object.entries(snapshot.sessions)
      .map(([key, value]) => [key, value.title])));
    setSessionMarkerColorsById(Object.fromEntries(Object.entries(snapshot.sessions)
      .map(([key, value]) => [key, value.markerColor])));
    setMessages(snapshot.composerHistory);
    for (const [key, pending] of Object.entries(pendingDrafts.current)) {
      if (connectionId(pending.connection) === id && (snapshot.drafts[key]?.text || "") === pending.text) delete pendingDrafts.current[key];
    }
    setDrafts(Object.entries({ ...snapshot.drafts, ...Object.fromEntries(Object.entries(pendingDrafts.current)
      .filter(([, pending]) => connectionId(pending.connection) === id && pending.text.trim())
      .map(([key, pending]) => [key, { text: pending.text, updatedAt: Date.now() }])) }).map(([key, value]) => {
      const [backendId, sessionId] = JSON.parse(key) as [string, string];
      return { backendId, sessionId, text: value.text, updatedAt: value.updatedAt };
    }).filter((draft) => pendingDrafts.current[runnerSessionKey(draft.backendId, draft.sessionId)]?.text !== ""
      || connectionId(pendingDrafts.current[runnerSessionKey(draft.backendId, draft.sessionId)]?.connection || connection) !== id));
    setDraftsLoaded(true);
  }, [setRegisteredDirectories, setSessionMarkerColorsById, setSessionTitleOverridesById]);

  const refresh = useCallback(async (connection: Connection) => {
    const { runnerUrl: url, runnerToken: token } = connection;
    if (!url || !token) return;
    let snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token });
    let migrated = false;
    {
      const legacy = await readPersistedSettings();
      const hasLegacyData = legacy && (
        parseComposerMessageHistory(legacy.composerMessageHistory).length > 0
        || parseComposerDrafts(legacy.composerDrafts).length > 0
        || (Array.isArray(legacy.registeredDirectories) && legacy.registeredDirectories.length > 0)
        || Object.keys(legacy.sessionTitleOverridesById || {}).length > 0
        || Object.keys(legacy.sessionMarkerColorsById || {}).length > 0
      );
      if (legacy && hasLegacyData && (!legacy.runnerUrl || String(legacy.runnerUrl).replace(/\/+$/, "") === url.replace(/\/+$/, ""))) {
        const sessions: Record<string, { title?: string; markerColor?: string }> = {};
        const titles = legacy.sessionTitleOverridesById as Record<string, string> || {};
        const colors = legacy.sessionMarkerColorsById as Record<string, string> || {};
        for (const sessionId of new Set([...Object.keys(titles), ...Object.keys(colors)])) {
          sessions[runnerSessionKey("legacy", sessionId)] = { title: titles[sessionId], markerColor: colors[sessionId] };
        }
        const drafts: Record<string, { text: string }> = {};
        for (const draft of parseComposerDrafts(legacy.composerDrafts)) {
          drafts[runnerSessionKey("legacy", draft.sessionId)] = { text: draft.text };
        }
        snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation: {
          type: "migrate", directories: parseRegisteredDirectories(legacy.registeredDirectories), sessions,
          composerHistory: parseComposerMessageHistory(legacy.composerMessageHistory), drafts,
        } });
        migrated = snapshot.migrationComplete === true;
      }
    }
    applySnapshot(snapshot, connection);
    for (const [key, pending] of Object.entries(pendingDrafts.current)) {
      if (connectionId(pending.connection) !== connectionId(connection)) continue;
      if (draftTimers.current[key] || queuedDrafts.current.has(`${connectionId(connection)}\u0000${key}`)) continue;
      const [draftBackendId, sessionId] = JSON.parse(key) as [string, string];
      snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation: {
        type: "draft.set", backendId: draftBackendId, sessionId, text: pending.text,
      } });
      applySnapshot(snapshot, connection);
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

  const enqueue = useCallback((operation?: Record<string, unknown>, selectedConnection = connectionRef.current) => {
    const connection = { ...selectedConnection };
    const next = queue.current.then(async () => {
      if (!snapshotRef.current || snapshotConnectionRef.current !== connectionId(connection) || !operation) await refresh(connection);
      if (!operation) return;
      const { runnerUrl: url, runnerToken: token } = connection;
      if (!url || !token) throw new Error("Runner connection is not configured");
      applySnapshot(await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation }), connection);
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

  const mutate = useCallback((operation: Record<string, unknown>, connection?: Connection) => {
    void enqueue(operation, connection).catch((error) => Alert.alert("Runner に保存できません", error instanceof Error ? error.message : String(error)));
  }, [enqueue]);

  const sendDraft = useCallback((backendId: string, sessionId: string, text: string, connection: Connection) => {
    const key = runnerSessionKey(backendId, sessionId);
    const queuedKey = `${connectionId(connection)}\u0000${key}`;
    queuedDrafts.current.add(queuedKey);
    void enqueue({ type: "draft.set", backendId, sessionId, text }, connection)
      .catch((error) => Alert.alert("Runner に保存できません", error instanceof Error ? error.message : String(error)))
      .finally(() => queuedDrafts.current.delete(queuedKey));
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
    const connection = { ...connectionRef.current };
    const previous = pendingDrafts.current[key];
    if (previous && connectionId(previous.connection) !== connectionId(connection)) {
      if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
      delete draftTimers.current[key];
      sendDraft(backendId, sessionId, previous.text, previous.connection);
    }
    pendingDrafts.current[key] = { text: nextText, connection };
    setDrafts((current) => [
      ...(nextText.trim() ? [{ backendId, sessionId, text: nextText, updatedAt: Date.now() }] : []),
      ...current.filter((draft) => draft.backendId !== backendId || draft.sessionId !== sessionId),
    ].slice(0, 10));
    if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
    draftTimers.current[key] = setTimeout(() => {
      delete draftTimers.current[key];
      sendDraft(backendId, sessionId, nextText, connection);
    }, 300);
  }, [sendDraft]);

  const clearDraft = useCallback((sessionId: string, backendId = connectionRef.current.backendId) => {
    const connection = { ...connectionRef.current };
    const key = runnerSessionKey(backendId, sessionId);
    if (draftTimers.current[key]) clearTimeout(draftTimers.current[key]);
    delete draftTimers.current[key];
    const previous = pendingDrafts.current[key];
    if (previous && connectionId(previous.connection) !== connectionId(connection)) {
      sendDraft(backendId, sessionId, previous.text, previous.connection);
    }
    pendingDrafts.current[key] = { text: "", connection };
    setDrafts((current) => current.filter((draft) => draft.sessionId !== sessionId
      || (draft.backendId !== backendId && draft.backendId !== "legacy")));
    sendDraft(backendId, sessionId, "", connection);
    if (snapshotRef.current?.drafts[runnerSessionKey("legacy", sessionId)]) {
      pendingDrafts.current[runnerSessionKey("legacy", sessionId)] = { text: "", connection };
      sendDraft("legacy", sessionId, "", connection);
    }
  }, [sendDraft]);

  useEffect(() => {
    const flush = () => {
      for (const key of Object.keys(draftTimers.current)) {
        clearTimeout(draftTimers.current[key]);
        delete draftTimers.current[key];
        const [draftBackendId, sessionId] = JSON.parse(key) as [string, string];
        const pending = pendingDrafts.current[key];
        if (pending) sendDraft(draftBackendId, sessionId, pending.text, pending.connection);
      }
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [sendDraft]);

  return { mutate, messages, recordMessage, drafts, draftsLoaded, setDraft, clearDraft };
}
