import { Alert } from "react-native";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RegisteredDirectoryEntry } from "../types/directorySessions";
import type { GitChangedFilesDirectoryState } from "../types/appTypes";
import { reconcileRegisteredDirectories } from "../utils/directoryIdentity";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";
import type { DirectoryTargetTransition } from "./useDirectorySessionTreeController";

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
  prepareDirectorySessionTargetChange: (params: {
    nextRegisteredDirectories: RegisteredDirectoryEntry[];
    transitions: DirectoryTargetTransition[];
  }) => void;
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
  prepareDirectorySessionTargetChange,
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
      const relativeMigrations = Array.from(canonicalPathByPath.entries()).filter(
        ([source, target]) => !source.startsWith("/") && target !== source
      );
      if (relativeMigrations.length > 0) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "ディレクトリ登録を更新",
            `相対パスを接続中runnerの絶対パスへ更新します。\n\n${relativeMigrations
              .map(([source, target]) => `${source} → ${target}`)
              .join("\n")}`,
            [
              { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
              { text: "更新", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) }
          );
        });
        if (cancelled || !confirmed) return;
        const migrationController = new AbortController();
        const migrationTimeout = setTimeout(
          () => migrationController.abort(),
          DIRECTORY_IDENTITY_HTTP_TIMEOUT_MS
        );
        const migrationResults = await Promise.all(relativeMigrations.map(async ([source, target]) => {
          try {
            return await fetch(`${baseUrl}/directory-identities/migrate`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ source, target }),
              signal: migrationController.signal,
            });
          } catch {
            return null;
          }
        }));
        clearTimeout(migrationTimeout);
        if (cancelled) return;
        if (migrationResults.some((response) => !response?.ok)) {
          Alert.alert(
            "ディレクトリ登録を更新できませんでした",
            "runnerを更新してから、もう一度接続してください。"
          );
          return;
        }
      }
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
      const reconciledById = new Map(reconciled.directories.map((directory) => [directory.id, directory]));
      const transitions: DirectoryTargetTransition[] = [];
      for (const directory of registeredDirectories) {
        const retainedId = reconciled.retainedIdByRemovedId.get(directory.id) || directory.id;
        const retained = reconciledById.get(retainedId);
        if (!retained) continue;
        if (retainedId !== directory.id || retained.path !== directory.path) {
          transitions.push({
            kind: "same_identity",
            fromId: directory.id,
            toId: retainedId,
            fromPath: directory.path,
            toPath: retained.path,
          });
        }
      }
      prepareDirectorySessionTargetChange({
        nextRegisteredDirectories: reconciled.directories,
        transitions,
      });
      setRegisteredDirectories(reconciled.directories);
      setExpandedDirectoryIds((current) => Array.from(new Set(current.map(
        (id) => reconciled.retainedIdByRemovedId.get(id) || id
      ))));
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
    prepareDirectorySessionTargetChange,
    setExpandedDirectoryIds,
    setGitChangedFilesByDirectory,
    setPanelRuntimeEntriesById,
    setRegisteredDirectories,
    setSelectedDirectory,
    settingsLoaded,
  ]);
}
