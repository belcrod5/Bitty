import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { DirectorySessionTreeState, RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { GitChangedFilesDirectoryState } from "../types/appTypes";
import { reconcileRegisteredDirectories } from "../utils/directoryIdentity";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

const DIRECTORY_IDENTITY_HTTP_TIMEOUT_MS = 12_000;
const DIRECTORY_IDENTITY_RETRY_MS = 2_000;

type Args = {
  settingsLoaded: boolean;
  auxServerBaseUrl: () => string;
  runnerToken: string;
  selectedDirectory: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  setSelectedDirectory: Dispatch<SetStateAction<string>>;
  setRegisteredDirectories: Dispatch<SetStateAction<RegisteredDirectoryEntry[]>>;
  setExpandedDirectoryIds: Dispatch<SetStateAction<string[]>>;
  setDirectorySessionsById: Dispatch<SetStateAction<Record<string, DirectorySessionTreeState>>>;
  setGitChangedFilesByDirectory: Dispatch<SetStateAction<Record<string, GitChangedFilesDirectoryState>>>;
  setPanelRuntimeEntriesById: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>>;
  llmSessionDirectoryRef: MutableRefObject<string>;
  gitChangedFilesByDirectoryRef: MutableRefObject<Record<string, GitChangedFilesDirectoryState>>;
  gitChangedFilesRefreshInFlightRef: MutableRefObject<Map<string, number>>;
  directoryIdentityGenerationRef: MutableRefObject<number>;
};

export function useDirectoryIdentityReconciliation({
  settingsLoaded,
  auxServerBaseUrl,
  runnerToken,
  selectedDirectory,
  registeredDirectories,
  setSelectedDirectory,
  setRegisteredDirectories,
  setExpandedDirectoryIds,
  setDirectorySessionsById,
  setGitChangedFilesByDirectory,
  setPanelRuntimeEntriesById,
  llmSessionDirectoryRef,
  gitChangedFilesByDirectoryRef,
  gitChangedFilesRefreshInFlightRef,
  directoryIdentityGenerationRef,
}: Args) {
  const requestRef = useRef("");

  useEffect(() => {
    const baseUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!settingsLoaded || !baseUrl || !token) return;
    const paths = Array.from(new Set([
      selectedDirectory,
      ...registeredDirectories.map((directory) => String(directory.path || "").trim()),
    ].filter(Boolean)));
    const requestKey = `${baseUrl}\n${token}\n${paths.join("\n")}`;
    if (requestRef.current === requestKey) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const reconcile = async () => {
      requestRef.current = requestKey;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DIRECTORY_IDENTITY_HTTP_TIMEOUT_MS);
      const resolvedPaths = await Promise.all(paths.map(async (directory) => {
        try {
          const url = new URL(`${baseUrl}/directories`);
          url.searchParams.set("path", directory);
          const response = await fetch(url.toString(), {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (response.status === 404) return [directory, directory] as const;
          if (!response.ok) return null;
          const data = await response.json().catch(() => ({})) as Record<string, unknown>;
          return [directory, String(data.basePath || directory).trim() || directory] as const;
        } catch {
          return null;
        }
      }));
      clearTimeout(timeout);
      if (cancelled) return;
      if (resolvedPaths.some((item) => item === null)) {
        requestRef.current = "";
        retryTimer = setTimeout(() => void reconcile(), DIRECTORY_IDENTITY_RETRY_MS);
        return;
      }
      const canonicalPathByPath = new Map(resolvedPaths.filter(
        (item): item is readonly [string, string] => item !== null
      ));
      const canonicalSelectedDirectory = canonicalPathByPath.get(selectedDirectory) || selectedDirectory;
      const reconciled = reconcileRegisteredDirectories(registeredDirectories, canonicalPathByPath);
      const identityChanged = (
        canonicalSelectedDirectory !== selectedDirectory ||
        reconciled.removedIds.length > 0 ||
        reconciled.directories.some((directory, index) => directory !== registeredDirectories[index])
      );
      if (!identityChanged) return;

      llmSessionDirectoryRef.current = canonicalSelectedDirectory;
      setSelectedDirectory(canonicalSelectedDirectory);
      setRegisteredDirectories(reconciled.directories);
      setExpandedDirectoryIds((current) => Array.from(new Set(current.map(
        (id) => reconciled.retainedIdByRemovedId.get(id) || id
      ))));
      setDirectorySessionsById((current) => {
        const next = { ...current };
        for (const removedId of reconciled.removedIds) {
          const retainedId = reconciled.retainedIdByRemovedId.get(removedId) || "";
          if (retainedId && !next[retainedId] && next[removedId]) next[retainedId] = next[removedId];
          delete next[removedId];
        }
        for (const [id, state] of Object.entries(next)) {
          next[id] = {
            ...state,
            entries: state.entries.map((entry) => ({
              ...entry,
              directory: canonicalPathByPath.get(entry.directory) || entry.directory,
            })),
            childrenByParentId: Object.fromEntries(Object.entries(state.childrenByParentId).map(([parentId, child]) => [
              parentId,
              {
                ...child,
                entries: child.entries.map((entry) => ({
                  ...entry,
                  directory: canonicalPathByPath.get(entry.directory) || entry.directory,
                })),
              },
            ])),
          };
        }
        return next;
      });
      setPanelRuntimeEntriesById((current) => Object.fromEntries(Object.entries(current).map(([id, entry]) => {
        const directory = entry.snapshot.selectedDirectoryPath;
        const canonicalDirectory = canonicalPathByPath.get(directory) || directory;
        if (canonicalDirectory === directory) return [id, entry];
        return [id, {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            selectedDirectoryPath: canonicalDirectory,
          },
        }];
      })));
      directoryIdentityGenerationRef.current += 1;
      setGitChangedFilesByDirectory((current) => {
        const next: Record<string, GitChangedFilesDirectoryState> = {};
        for (const [directory, state] of Object.entries(current)) {
          const canonicalDirectory = canonicalPathByPath.get(directory) || directory;
          next[canonicalDirectory] = next[canonicalDirectory] || { ...state, loading: false };
        }
        gitChangedFilesByDirectoryRef.current = next;
        return next;
      });
      gitChangedFilesRefreshInFlightRef.current.clear();
    };

    void reconcile();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (requestRef.current === requestKey) requestRef.current = "";
    };
  }, [
    auxServerBaseUrl,
    directoryIdentityGenerationRef,
    gitChangedFilesByDirectoryRef,
    gitChangedFilesRefreshInFlightRef,
    llmSessionDirectoryRef,
    registeredDirectories,
    runnerToken,
    selectedDirectory,
    setDirectorySessionsById,
    setExpandedDirectoryIds,
    setGitChangedFilesByDirectory,
    setPanelRuntimeEntriesById,
    setRegisteredDirectories,
    setSelectedDirectory,
    settingsLoaded,
  ]);
}
