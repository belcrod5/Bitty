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
  addSkiaBoardDirectory,
  addSkiaBoardFile,
  addSkiaBoardSection,
  addSkiaBoardSession,
  ingestSkiaBoardSessions,
  markSkiaBoardFileUnavailable,
  moveSkiaBoardCard,
  readPersistedSkiaBoardState,
  removeSkiaBoardDirectory,
  removeSkiaBoardFile,
  removeSkiaBoardSession,
  removeSkiaBoardSection,
  setSkiaBoardCardTextScale,
  SKIA_BOARD_DEFAULT_TEXT_SCALE,
  skiaBoardDirectoryId,
  skiaBoardFileId,
  tidySkiaBoardCards,
  updateSkiaBoardSection,
  writePersistedSkiaBoardState,
  type SkiaBoardDirectoryCard,
  type SkiaBoardFileCard,
  type SkiaBoardState,
  type SkiaBoardSection,
} from "../utils/skiaBoardState";

type SkiaBoardContextValue = {
  state: SkiaBoardState | null;
  loaded: boolean;
  addSession: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  hasSession: (sessionId: string) => boolean;
  addDirectory: (target: Pick<SkiaBoardDirectoryCard, "directory" | "name">) => void;
  removeDirectory: (directory: string) => void;
  hasDirectory: (directory: string) => boolean;
  addFile: (file: Pick<SkiaBoardFileCard, "rootDir" | "path" | "name">) => void;
  removeFile: (rootDir: string, path: string) => void;
  markFileUnavailable: (rootDir: string, path: string) => void;
  hasFile: (rootDir: string, path: string) => boolean;
  moveCard: (cardId: string, col: number, row: number) => void;
  addSection: (section: SkiaBoardSection) => void;
  updateSection: (sectionId: string, update: Partial<Omit<SkiaBoardSection, "id">>) => void;
  removeSection: (sectionId: string) => void;
  tidyCards: (visibleCardIds: readonly string[]) => void;
  setCardTextScale: (scale: number) => void;
};

const SkiaBoardContext = createContext<SkiaBoardContextValue | null>(null);

type SkiaBoardStateUpdate = (current: SkiaBoardState | null) => SkiaBoardState | null;

export function SkiaBoardProvider({ children }: { children: ReactNode }) {
  const {
    registeredDirectories,
    directorySessionsById,
    directorySessionSync,
  } = useConversation();
  const [state, setState] = useState<SkiaBoardState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const persistenceWritableRef = useRef(false);
  const persistenceRecoveryInFlightRef = useRef(false);
  const pendingStateUpdatesRef = useRef<SkiaBoardStateUpdate[]>([]);
  const lastPersistedStateRef = useRef<SkiaBoardState | null>(null);
  const mountedRef = useRef(false);

  const sessionCandidates = useMemo(() => (
    collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)
  ), [directorySessionsById, registeredDirectories]);

  const recoverPersistence = useCallback(async () => {
    if (persistenceWritableRef.current || persistenceRecoveryInFlightRef.current) return;
    persistenceRecoveryInFlightRef.current = true;
    try {
      const persisted = await readPersistedSkiaBoardState();
      if (!mountedRef.current) return;
      const recovered = pendingStateUpdatesRef.current.reduce(
        (current, update) => update(current),
        persisted
      );
      pendingStateUpdatesRef.current = [];
      lastPersistedStateRef.current = persisted;
      persistenceWritableRef.current = true;
      setState(recovered);
      setLoaded(true);
    } catch (error) {
      if (!mountedRef.current) return;
      console.warn("[skia_board] failed to read persisted board state", error);
      // Keep the board usable in memory. Each later board mutation retries this read;
      // queued mutations are applied to the saved state only after it becomes readable.
      setLoaded(true);
    } finally {
      persistenceRecoveryInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void recoverPersistence();
    return () => {
      mountedRef.current = false;
    };
  }, [recoverPersistence]);

  const updateLoadedState = useCallback((update: SkiaBoardStateUpdate) => {
    if (!loaded) return;
    if (!persistenceWritableRef.current) {
      pendingStateUpdatesRef.current.push(update);
    }
    setState(update);
    if (!persistenceWritableRef.current) void recoverPersistence();
  }, [loaded, recoverPersistence]);

  const directorySyncSettled = (
    directorySessionSync.phase === "idle"
    || directorySessionSync.phase === "complete"
  );
  useEffect(() => {
    if (!loaded || !directorySyncSettled) return;
    updateLoadedState((current) => ingestSkiaBoardSessions(current, sessionCandidates));
  }, [directorySyncSettled, loaded, sessionCandidates, updateLoadedState]);

  useEffect(() => {
    if (
      !loaded
      || !persistenceWritableRef.current
      || !state
      || state === lastPersistedStateRef.current
    ) return;
    writePersistedSkiaBoardState(state)
      .then(() => {
        lastPersistedStateRef.current = state;
      })
      .catch((error) => {
        console.warn("[skia_board] failed to persist board state", error);
      });
  }, [loaded, state]);

  const updateInitializedState = useCallback((update: (current: SkiaBoardState) => SkiaBoardState) => {
    updateLoadedState((current) => {
      const initialized = current || ingestSkiaBoardSessions(null, sessionCandidates) || {
        cards: [],
        sections: [],
        excludedSessionIds: [],
        ingestedUpdatedAtMs: 0,
        cardTextScale: SKIA_BOARD_DEFAULT_TEXT_SCALE,
      };
      return update(initialized);
    });
  }, [sessionCandidates, updateLoadedState]);

  const addSession = useCallback((sessionId: string) => {
    updateInitializedState((current) => addSkiaBoardSession(current, sessionId));
  }, [updateInitializedState]);
  const removeSession = useCallback((sessionId: string) => {
    updateInitializedState((current) => removeSkiaBoardSession(current, sessionId));
  }, [updateInitializedState]);
  const addDirectory = useCallback((target: Pick<SkiaBoardDirectoryCard, "directory" | "name">) => {
    updateInitializedState((current) => addSkiaBoardDirectory(current, target));
  }, [updateInitializedState]);
  const removeDirectory = useCallback((directory: string) => {
    updateInitializedState((current) => removeSkiaBoardDirectory(current, directory));
  }, [updateInitializedState]);
  const addFile = useCallback((file: Pick<SkiaBoardFileCard, "rootDir" | "path" | "name">) => {
    updateInitializedState((current) => addSkiaBoardFile(current, file));
  }, [updateInitializedState]);
  const removeFile = useCallback((rootDir: string, path: string) => {
    updateInitializedState((current) => removeSkiaBoardFile(current, rootDir, path));
  }, [updateInitializedState]);
  const markFileUnavailable = useCallback((rootDir: string, path: string) => {
    updateInitializedState((current) => markSkiaBoardFileUnavailable(current, rootDir, path));
  }, [updateInitializedState]);
  const moveCard = useCallback((cardId: string, col: number, row: number) => {
    updateInitializedState((current) => moveSkiaBoardCard(current, cardId, col, row));
  }, [updateInitializedState]);
  const addSection = useCallback((section: SkiaBoardSection) => {
    updateInitializedState((current) => addSkiaBoardSection(current, section));
  }, [updateInitializedState]);
  const updateSection = useCallback((
    sectionId: string,
    update: Partial<Omit<SkiaBoardSection, "id">>
  ) => {
    updateInitializedState((current) => updateSkiaBoardSection(current, sectionId, update));
  }, [updateInitializedState]);
  const removeSection = useCallback((sectionId: string) => {
    updateInitializedState((current) => removeSkiaBoardSection(current, sectionId));
  }, [updateInitializedState]);
  const tidyCards = useCallback((visibleCardIds: readonly string[]) => {
    updateInitializedState((current) => tidySkiaBoardCards(current, visibleCardIds));
  }, [updateInitializedState]);
  const setCardTextScale = useCallback((scale: number) => {
    updateInitializedState((current) => setSkiaBoardCardTextScale(current, scale));
  }, [updateInitializedState]);

  const sessionIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "session" ? [card.sessionId] : []
  ))), [state]);
  const directoryIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "directory" ? [skiaBoardDirectoryId(card.directory)] : []
  ))), [state]);
  const fileIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "file" && !card.unavailable ? [skiaBoardFileId(card.rootDir, card.path)] : []
  ))), [state]);
  const hasSession = useCallback((sessionId: string) => sessionIds.has(sessionId), [sessionIds]);
  const hasDirectory = useCallback(
    (directory: string) => directoryIds.has(skiaBoardDirectoryId(directory)),
    [directoryIds]
  );
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
    addDirectory,
    removeDirectory,
    hasDirectory,
    addFile,
    removeFile,
    markFileUnavailable,
    hasFile,
    moveCard,
    addSection,
    updateSection,
    removeSection,
    tidyCards,
    setCardTextScale,
  }), [
    addDirectory,
    addFile,
    addSession,
    hasDirectory,
    hasFile,
    hasSession,
    loaded,
    markFileUnavailable,
    moveCard,
    addSection,
    updateSection,
    removeSection,
    removeDirectory,
    removeFile,
    removeSession,
    state,
    setCardTextScale,
    tidyCards,
  ]);

  return <SkiaBoardContext.Provider value={value}>{children}</SkiaBoardContext.Provider>;
}

export function useSkiaBoard() {
  const context = useContext(SkiaBoardContext);
  if (!context) throw new Error("useSkiaBoard must be used within SkiaBoardProvider");
  return context;
}
