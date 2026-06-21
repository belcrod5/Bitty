import { useCallback, useLayoutEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  GitChangedFilesDirectoryState,
  GitChangedFilesSnapshot,
} from "../types/appTypes";

const GIT_CHANGED_FILES_HTTP_TIMEOUT_MS = 12_000;

type SessionDiagLogger = (
  event: string,
  payload?: Record<string, unknown>,
  options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
) => void;

type UseGitChangedFilesControllerArgs = {
  auxServerBaseUrl: () => string;
  runnerToken: string;
  gitChangedFilesByDirectoryRef: MutableRefObject<Record<string, GitChangedFilesDirectoryState>>;
  gitChangedFilesRefreshInFlightRef: MutableRefObject<Map<string, number>>;
  directoryIdentityGenerationRef: MutableRefObject<number>;
  setGitChangedFilesByDirectory: Dispatch<SetStateAction<Record<string, GitChangedFilesDirectoryState>>>;
  logSessionDiag: SessionDiagLogger;
};

export function useGitChangedFilesController({
  auxServerBaseUrl,
  runnerToken,
  gitChangedFilesByDirectoryRef,
  gitChangedFilesRefreshInFlightRef,
  directoryIdentityGenerationRef,
  setGitChangedFilesByDirectory,
  logSessionDiag,
}: UseGitChangedFilesControllerArgs) {
  useLayoutEffect(() => {
    directoryIdentityGenerationRef.current += 1;
    gitChangedFilesRefreshInFlightRef.current.clear();
    gitChangedFilesByDirectoryRef.current = {};
    setGitChangedFilesByDirectory({});
  }, [
    auxServerBaseUrl,
    directoryIdentityGenerationRef,
    gitChangedFilesByDirectoryRef,
    gitChangedFilesRefreshInFlightRef,
    runnerToken,
    setGitChangedFilesByDirectory,
  ]);

  const fetchRunnerGitChangedFiles = useCallback(async (directoryRaw?: unknown): Promise<{
    directory: string;
    snapshot: GitChangedFilesSnapshot | null;
    errorMessage: string;
  }> => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      return {
        directory: "",
        snapshot: null,
        errorMessage: "Runner URL または token が未設定です。",
      };
    }
    try {
      const url = new URL(`${targetLlmUrl}/git/changed-files`);
      const directory = String(directoryRaw || "").trim();
      if (directory) {
        url.searchParams.set("directory", directory);
      }
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let res: Response;
      let data: Record<string, unknown>;
      try {
        const request = fetch(url.toString(), {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        }).then(async (response) => ({
          response,
          data: await response.json().catch(() => ({})),
        }));
        const timeout = new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error(`request timeout (${GIT_CHANGED_FILES_HTTP_TIMEOUT_MS}ms)`));
          }, GIT_CHANGED_FILES_HTTP_TIMEOUT_MS);
        });
        const result = await Promise.race([request, timeout]);
        res = result.response;
        data = result.data;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      if (!res.ok) {
        const message = String(data?.message || data?.error || `HTTP ${res.status}`).trim();
        return {
          directory: "",
          snapshot: null,
          errorMessage: message || "差分一覧の取得に失敗しました。",
        };
      }
      const stagedFiles = Array.isArray(data?.stagedFiles)
        ? data.stagedFiles.map((item: unknown) => String(item || "").trim()).filter((item: string) => !!item)
        : [];
      const unstagedFiles = Array.isArray(data?.unstagedFiles)
        ? data.unstagedFiles.map((item: unknown) => String(item || "").trim()).filter((item: string) => !!item)
        : [];
      const untrackedFiles = Array.isArray(data?.untrackedFiles)
        ? data.untrackedFiles.map((item: unknown) => String(item || "").trim()).filter((item: string) => !!item)
        : [];
      const branches = Array.isArray(data?.branches)
        ? data.branches
          .map((itemRaw: unknown) => {
            const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
            const name = String(item.name || "").trim();
            const kind = String(item.kind || "").trim();
            if (!name || (kind !== "local" && kind !== "remote")) return null;
            return { name, kind };
          })
          .filter((item): item is { name: string; kind: "local" | "remote" } => Boolean(item))
        : [];
      return {
        directory: String(data?.directory || directoryRaw || "").trim(),
        snapshot: {
          branchName: String(data?.branchName || "").trim(),
          behindCount: Math.max(0, Math.floor(Number(data?.behindCount) || 0)),
          branches,
          stagedFiles,
          unstagedFiles,
          untrackedFiles,
          fetchedAt: String(data?.fetchedAt || new Date().toISOString()),
        },
        errorMessage: "",
      };
    } catch (err) {
      if (err && typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError") {
        return {
          directory: "",
          snapshot: null,
          errorMessage: `request timeout (${GIT_CHANGED_FILES_HTTP_TIMEOUT_MS}ms)`,
        };
      }
      return {
        directory: "",
        snapshot: null,
        errorMessage: err instanceof Error && err.message
          ? err.message
          : String(err || "unknown_error"),
      };
    }
  }, [auxServerBaseUrl, runnerToken]);

  const updateDirectoryState = useCallback((
    directory: string,
    update: (current: GitChangedFilesDirectoryState) => GitChangedFilesDirectoryState,
    createIfMissing = true,
  ) => {
    setGitChangedFilesByDirectory((prev) => {
      if (!createIfMissing && !prev[directory]) return prev;
      const current = prev[directory] || {
        snapshot: null,
        loading: false,
        error: "",
      };
      const next = {
        ...prev,
        [directory]: update(current),
      };
      gitChangedFilesByDirectoryRef.current = next;
      return next;
    });
  }, [gitChangedFilesByDirectoryRef, setGitChangedFilesByDirectory]);

  const refreshGitChangedFiles = useCallback(async (
    directoryRaw: unknown,
    options?: { force?: boolean },
  ) => {
    const directory = String(directoryRaw || "").trim();
    if (!directory) return;
    if (!options?.force && gitChangedFilesByDirectoryRef.current[directory]?.snapshot) {
      logSessionDiag("git_changed_files_refresh_skipped_cached", {
        directory,
      }, { throttleMs: 0 });
      return;
    }
    if (gitChangedFilesRefreshInFlightRef.current.has(directory)) {
      logSessionDiag("git_changed_files_refresh_skipped_in_flight", {
        directory,
      }, { throttleMs: 0 });
      return;
    }
    const startedAt = Date.now();
    const identityGeneration = directoryIdentityGenerationRef.current;
    logSessionDiag("git_changed_files_refresh_start", {
      directory,
      force: Boolean(options?.force),
    }, { throttleMs: 0 });
    gitChangedFilesRefreshInFlightRef.current.set(directory, identityGeneration);
    updateDirectoryState(directory, (current) => ({
      ...current,
      loading: true,
      error: "",
    }));
    try {
      const { directory: canonicalDirectoryRaw, snapshot, errorMessage } = await fetchRunnerGitChangedFiles(directory);
      if (directoryIdentityGenerationRef.current !== identityGeneration) return;
      if (!snapshot) {
        updateDirectoryState(directory, (current) => ({
          ...current,
          error: errorMessage || "差分一覧の取得に失敗しました。",
        }), false);
        logSessionDiag("git_changed_files_refresh_error", {
          directory,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: errorMessage || "差分一覧の取得に失敗しました。",
        }, { throttleMs: 0 });
        return;
      }
      const canonicalDirectory = canonicalDirectoryRaw || directory;
      setGitChangedFilesByDirectory((prev) => {
        const current = prev[directory] || prev[canonicalDirectory] || {
          snapshot: null,
          loading: false,
          error: "",
        };
        const next = { ...prev };
        if (canonicalDirectory !== directory) delete next[directory];
        next[canonicalDirectory] = {
          ...current,
          snapshot,
          loading: false,
          error: "",
        };
        gitChangedFilesByDirectoryRef.current = next;
        return next;
      });
      logSessionDiag("git_changed_files_refresh_done", {
        directory: canonicalDirectory,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        stagedCount: snapshot.stagedFiles.length,
        unstagedCount: snapshot.unstagedFiles.length,
        untrackedCount: snapshot.untrackedFiles.length,
      }, { throttleMs: 0 });
    } finally {
      if (gitChangedFilesRefreshInFlightRef.current.get(directory) === identityGeneration) {
        gitChangedFilesRefreshInFlightRef.current.delete(directory);
      }
      if (directoryIdentityGenerationRef.current !== identityGeneration) return;
      updateDirectoryState(directory, (current) => ({
        ...current,
        loading: false,
      }), false);
      logSessionDiag("git_changed_files_refresh_settled", {
        directory,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        loading: false,
      }, { throttleMs: 0 });
    }
  }, [
    fetchRunnerGitChangedFiles,
    directoryIdentityGenerationRef,
    gitChangedFilesByDirectoryRef,
    gitChangedFilesRefreshInFlightRef,
    logSessionDiag,
    setGitChangedFilesByDirectory,
    updateDirectoryState,
  ]);

  return {
    refreshGitChangedFiles,
  };
}
