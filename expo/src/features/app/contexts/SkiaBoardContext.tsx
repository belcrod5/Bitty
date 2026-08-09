import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConversation } from "./ConversationContext";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import {
  addSkiaBoardFile,
  addSkiaBoardSession,
  ingestSkiaBoardSessions,
  markSkiaBoardFileUnavailable,
  moveSkiaBoardCard,
  readPersistedSkiaBoardState,
  removeSkiaBoardFile,
  removeSkiaBoardSession,
  skiaBoardFileId,
  tidySkiaBoardCards,
  writePersistedSkiaBoardState,
  type SkiaBoardFileCard,
  type SkiaBoardState,
} from "../utils/skiaBoardState";

type SkiaBoardContextValue = {
  state: SkiaBoardState | null;
  loaded: boolean;
  addSession: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  hasSession: (sessionId: string) => boolean;
  addFile: (file: Pick<SkiaBoardFileCard, "rootDir" | "path" | "name">) => void;
  removeFile: (rootDir: string, path: string) => void;
  markFileUnavailable: (rootDir: string, path: string) => void;
  hasFile: (rootDir: string, path: string) => boolean;
  moveCard: (cardId: string, col: number, row: number) => void;
  tidyCards: () => void;
};

const SkiaBoardContext = createContext<SkiaBoardContextValue | null>(null);

export function SkiaBoardProvider({ children }: { children: ReactNode }) {
  const {
    registeredDirectories,
    directorySessionsById,
    directorySessionSync,
  } = useConversation();
  const [state, setState] = useState<SkiaBoardState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lastPersistedStateRef = useRef<SkiaBoardState | null>(null);

  const sessionCandidates = useMemo(() => (
    collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)
  ), [directorySessionsById, registeredDirectories]);

  useEffect(() => {
    let cancelled = false;
    readPersistedSkiaBoardState()
      .then((persisted) => {
        if (cancelled) return;
        lastPersistedStateRef.current = persisted;
        setState(persisted);
        setLoaded(true);
      })
      .catch((error) => {
        console.warn("[skia_board] failed to read persisted board state", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const directorySyncSettled = (
    directorySessionSync.phase === "idle"
    || directorySessionSync.phase === "complete"
  );
  useEffect(() => {
    if (!loaded || !directorySyncSettled) return;
    setState((current) => ingestSkiaBoardSessions(current, sessionCandidates));
  }, [directorySyncSettled, loaded, sessionCandidates]);

  useEffect(() => {
    if (!loaded || !state || state === lastPersistedStateRef.current) return;
    writePersistedSkiaBoardState(state)
      .then(() => {
        lastPersistedStateRef.current = state;
      })
      .catch((error) => {
        console.warn("[skia_board] failed to persist board state", error);
      });
  }, [loaded, state]);

  const updateLoadedState = useCallback((update: (current: SkiaBoardState) => SkiaBoardState) => {
    if (!loaded) return;
    setState((current) => {
      const initialized = current || ingestSkiaBoardSessions(null, sessionCandidates) || {
        cards: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 0,
      };
      return update(initialized);
    });
  }, [loaded, sessionCandidates]);

  const addSession = useCallback((sessionId: string) => {
    updateLoadedState((current) => addSkiaBoardSession(current, sessionId));
  }, [updateLoadedState]);
  const removeSession = useCallback((sessionId: string) => {
    updateLoadedState((current) => removeSkiaBoardSession(current, sessionId));
  }, [updateLoadedState]);
  const addFile = useCallback((file: Pick<SkiaBoardFileCard, "rootDir" | "path" | "name">) => {
    updateLoadedState((current) => addSkiaBoardFile(current, file));
  }, [updateLoadedState]);
  const removeFile = useCallback((rootDir: string, path: string) => {
    updateLoadedState((current) => removeSkiaBoardFile(current, rootDir, path));
  }, [updateLoadedState]);
  const markFileUnavailable = useCallback((rootDir: string, path: string) => {
    updateLoadedState((current) => markSkiaBoardFileUnavailable(current, rootDir, path));
  }, [updateLoadedState]);
  const moveCard = useCallback((cardId: string, col: number, row: number) => {
    updateLoadedState((current) => moveSkiaBoardCard(current, cardId, col, row));
  }, [updateLoadedState]);
  const tidyCards = useCallback(() => {
    updateLoadedState(tidySkiaBoardCards);
  }, [updateLoadedState]);

  const sessionIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "session" ? [card.sessionId] : []
  ))), [state]);
  const fileIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "file" && !card.unavailable ? [skiaBoardFileId(card.rootDir, card.path)] : []
  ))), [state]);
  const hasSession = useCallback((sessionId: string) => sessionIds.has(sessionId), [sessionIds]);
  const hasFile = useCallback(
    (rootDir: string, path: string) => fileIds.has(skiaBoardFileId(rootDir, path)),
    [fileIds]
  );

  const value = useMemo<SkiaBoardContextValue>(() => ({
    state,
    loaded,
    addSession,
    removeSession,
    hasSession,
    addFile,
    removeFile,
    markFileUnavailable,
    hasFile,
    moveCard,
    tidyCards,
  }), [
    addFile,
    addSession,
    hasFile,
    hasSession,
    loaded,
    markFileUnavailable,
    moveCard,
    removeFile,
    removeSession,
    state,
    tidyCards,
  ]);

  return <SkiaBoardContext.Provider value={value}>{children}</SkiaBoardContext.Provider>;
}

export function useSkiaBoard() {
  const context = useContext(SkiaBoardContext);
  if (!context) throw new Error("useSkiaBoard must be used within SkiaBoardProvider");
  return context;
}
