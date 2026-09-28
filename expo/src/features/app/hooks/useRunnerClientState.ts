import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, AppState } from "react-native";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import { requestRunnerClientState, runnerSessionKey, type RunnerClientState } from "../utils/runnerClientState";
import type { ComposerDraft } from "./useComposerPersistence";

type Options = {
  settingsLoaded: boolean;
  runnerUrl: string;
  localRunnerUrl: string;
  cloudflareRunnerUrl: string;
  runnerToken: string;
  backendId: string;
  setRegisteredDirectories: Dispatch<SetStateAction<RegisteredDirectoryEntry[]>>;
  setSessionTitleOverridesById: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMarkerColorsById: Dispatch<SetStateAction<Record<string, RegisteredDirectoryEntry["markerColor"]>>>;
};

type Connection = { runnerUrl: string; runnerToken: string; backendId: string; id: string };
const pendingKey = (connection: Connection, key: string) => `${connection.id}\u0000${key}`;
function selectedConnection(runnerUrl: string, runnerToken: string, backendId: string, localRunnerUrl: string, cloudflareRunnerUrl: string): Connection {
  const url = runnerUrl.trim().replace(/\/+$/, "");
  const local = localRunnerUrl.trim().replace(/\/+$/, "");
  const cloudflare = cloudflareRunnerUrl.trim().replace(/\/+$/, "");
  const canonicalUrl = cloudflare && local && (url === local || url === cloudflare) ? cloudflare : url;
  return { runnerUrl: url, runnerToken, backendId, id: JSON.stringify([canonicalUrl, runnerToken]) };
}

export function useRunnerClientState({
  settingsLoaded, runnerUrl, localRunnerUrl, cloudflareRunnerUrl, runnerToken, backendId,
  setRegisteredDirectories, setSessionTitleOverridesById, setSessionMarkerColorsById,
}: Options) {
  const [messages, setMessages] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ComposerDraft[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const snapshotRef = useRef<RunnerClientState | null>(null);
  const snapshotConnectionRef = useRef("");
  const currentConnection = selectedConnection(runnerUrl, runnerToken, backendId, localRunnerUrl, cloudflareRunnerUrl);
  const connectionRef = useRef(currentConnection);
  connectionRef.current = currentConnection;
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const queuedDrafts = useRef(new Set<string>());
  const pendingDrafts = useRef<Record<string, { text: string; connection: Connection }>>({});

  const applySnapshot = useCallback((snapshot: RunnerClientState, connection: Connection) => {
    const id = connection.id;
    if (id !== connectionRef.current.id) return;
    for (const [key, pending] of Object.entries(pendingDrafts.current)) {
      if (pending.connection.id === id) {
        const sessionKey = key.slice(id.length + 1);
        if ((snapshot.drafts[sessionKey]?.text || "") === pending.text) delete pendingDrafts.current[key];
      }
    }
    if (snapshotConnectionRef.current === id && snapshotRef.current?.revision === snapshot.revision) return;
    snapshotConnectionRef.current = id;
    snapshotRef.current = snapshot;
    setRegisteredDirectories((current) => JSON.stringify(current) === JSON.stringify(snapshot.directories) ? current : snapshot.directories);
    setSessionTitleOverridesById(Object.fromEntries(Object.entries(snapshot.sessions)
      .map(([key, value]) => [key, value.title])));
    setSessionMarkerColorsById(Object.fromEntries(Object.entries(snapshot.sessions)
      .map(([key, value]) => [key, value.markerColor])));
    setMessages(snapshot.composerHistory);
    setDrafts(Object.entries({ ...snapshot.drafts, ...Object.fromEntries(Object.entries(pendingDrafts.current)
      .filter(([, pending]) => pending.connection.id === id && pending.text.trim())
      .map(([key, pending]) => [key.slice(id.length + 1), { text: pending.text, updatedAt: Date.now() }])) }).map(([key, value]) => {
      const [backendId, sessionId] = JSON.parse(key) as [string, string];
      return { backendId, sessionId, text: value.text, updatedAt: value.updatedAt };
    }).filter((draft) => pendingDrafts.current[pendingKey(connection, runnerSessionKey(draft.backendId, draft.sessionId))]?.text !== ""));
    setDraftsLoaded(true);
  }, [setRegisteredDirectories, setSessionMarkerColorsById, setSessionTitleOverridesById]);

  const refresh = useCallback(async (connection: Connection) => {
    const active = connection.id === connectionRef.current.id ? connectionRef.current : connection;
    const { runnerUrl: url, runnerToken: token } = active;
    if (!url || !token) return;
    let snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token });
    applySnapshot(snapshot, connection);
    for (const [key, pending] of Object.entries(pendingDrafts.current)) {
      if (pending.connection.id !== connection.id) continue;
      if (draftTimers.current[key] || queuedDrafts.current.has(key)) continue;
      const [draftBackendId, sessionId] = JSON.parse(key.slice(connection.id.length + 1)) as [string, string];
      snapshot = await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation: {
        type: "draft.set", backendId: draftBackendId, sessionId, text: pending.text,
      } });
      applySnapshot(snapshot, connection);
    }
  }, [applySnapshot]);

  const enqueue = useCallback((operation?: Record<string, unknown>, selectedConnection = connectionRef.current) => {
    const connection = { ...selectedConnection };
    const next = queue.current.then(async () => {
      if (!snapshotRef.current || snapshotConnectionRef.current !== connection.id || !operation) await refresh(connection);
      if (!operation) return;
      const active = connection.id === connectionRef.current.id ? connectionRef.current : connection;
      const { runnerUrl: url, runnerToken: token } = active;
      if (!url || !token) throw new Error("Runner connection is not configured");
      applySnapshot(await requestRunnerClientState({ runnerUrl: url, runnerToken: token, operation }), connection);
    });
    queue.current = next.catch(() => {});
    return next;
  }, [applySnapshot, refresh]);

  useEffect(() => {
    snapshotRef.current = null;
    snapshotConnectionRef.current = "";
    setRegisteredDirectories([]);
    setSessionTitleOverridesById({});
    setSessionMarkerColorsById({});
    setMessages([]);
    setDrafts([]);
    setDraftsLoaded(false);
    if (!settingsLoaded || !runnerToken) return;
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
  }, [enqueue, currentConnection.id, settingsLoaded, setRegisteredDirectories, setSessionTitleOverridesById, setSessionMarkerColorsById]);

  const previousRoute = useRef(runnerUrl);
  useEffect(() => {
    if (previousRoute.current === runnerUrl) return;
    previousRoute.current = runnerUrl;
    if (settingsLoaded && runnerToken) void enqueue().catch((error) => console.warn("[client-state] failed to refresh", error));
  }, [enqueue, runnerUrl, runnerToken, settingsLoaded]);

  const mutate = useCallback((operation: Record<string, unknown>, connection?: Connection) => {
    void enqueue(operation, connection).catch((error) => Alert.alert("Runner に保存できません", error instanceof Error ? error.message : String(error)));
  }, [enqueue]);

  const sendDraft = useCallback((backendId: string, sessionId: string, text: string, connection: Connection) => {
    const key = runnerSessionKey(backendId, sessionId);
    const queuedKey = pendingKey(connection, key);
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
    const scopedKey = pendingKey(connection, key);
    pendingDrafts.current[scopedKey] = { text: nextText, connection };
    setDrafts((current) => [
      ...(nextText.trim() ? [{ backendId, sessionId, text: nextText, updatedAt: Date.now() }] : []),
      ...current.filter((draft) => draft.backendId !== backendId || draft.sessionId !== sessionId),
    ].slice(0, 10));
    if (draftTimers.current[scopedKey]) clearTimeout(draftTimers.current[scopedKey]);
    draftTimers.current[scopedKey] = setTimeout(() => {
      delete draftTimers.current[scopedKey];
      sendDraft(backendId, sessionId, nextText, connection);
    }, 300);
  }, [sendDraft]);

  const clearDraft = useCallback((sessionId: string, backendId = connectionRef.current.backendId) => {
    const connection = { ...connectionRef.current };
    const key = runnerSessionKey(backendId, sessionId);
    const scopedKey = pendingKey(connection, key);
    if (draftTimers.current[scopedKey]) clearTimeout(draftTimers.current[scopedKey]);
    delete draftTimers.current[scopedKey];
    pendingDrafts.current[scopedKey] = { text: "", connection };
    setDrafts((current) => current.filter((draft) => draft.sessionId !== sessionId || draft.backendId !== backendId));
    sendDraft(backendId, sessionId, "", connection);
  }, [sendDraft]);

  useEffect(() => {
    const flush = () => {
      for (const key of Object.keys(draftTimers.current)) {
        clearTimeout(draftTimers.current[key]);
        delete draftTimers.current[key];
        const pending = pendingDrafts.current[key];
        if (!pending) continue;
        const [draftBackendId, sessionId] = JSON.parse(key.slice(pending.connection.id.length + 1)) as [string, string];
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

  return { mutate, messages, recordMessage, drafts, draftsLoaded, setDraft, clearDraft, scopeId: currentConnection.id };
}
