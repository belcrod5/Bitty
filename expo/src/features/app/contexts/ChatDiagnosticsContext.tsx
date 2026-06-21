import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import type {
  CodexAuthProfileEntry,
  GitChangedFilesDirectoryState,
} from "../types/appTypes";

export type ChatDiagnosticsContextValue = {
  codexCliStatusText: string;
  codexCliStatusFetchedAtMs: number;
  codexCliStatusLoading: boolean;
  codexAuthProfileId: string;
  codexAuthProfiles: CodexAuthProfileEntry[];
  codexAuthProfilesLoading: boolean;
  codexAuthSwitching: boolean;
  codexAuthSwitchError: string;
  gitChangedFilesByDirectory: Record<string, GitChangedFilesDirectoryState>;
  refreshGitChangedFiles: (
    directory: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  refreshCodexCliStatus: () => void;
  loadCodexAuthProfiles: () => void;
  switchCodexAuthProfile: (authId: string) => Promise<boolean>;
};

const ChatDiagnosticsContext = createContext<ChatDiagnosticsContextValue | null>(null);
const EMPTY_GIT_CHANGED_FILES: string[] = [];

type ChatDiagnosticsProviderProps = {
  value: ChatDiagnosticsContextValue;
  children: ReactNode;
};

export function ChatDiagnosticsProvider({ value, children }: ChatDiagnosticsProviderProps) {
  return <ChatDiagnosticsContext.Provider value={value}>{children}</ChatDiagnosticsContext.Provider>;
}

export function useChatDiagnostics() {
  const context = useContext(ChatDiagnosticsContext);
  if (!context) {
    throw new Error("useChatDiagnostics must be used within ChatDiagnosticsProvider");
  }
  return context;
}

export function useDirectoryGitChangedFiles(directoryRaw: unknown) {
  const {
    gitChangedFilesByDirectory,
    refreshGitChangedFiles,
  } = useChatDiagnostics();
  const directory = String(directoryRaw || "").trim();
  const state = gitChangedFilesByDirectory[directory];

  useEffect(() => {
    if (!directory) return;
    void refreshGitChangedFiles(directory);
  }, [directory, refreshGitChangedFiles]);

  const refresh = useCallback(() => (
    refreshGitChangedFiles(directory, { force: true })
  ), [directory, refreshGitChangedFiles]);

  return {
    branchName: state?.snapshot?.branchName || "HEAD",
    behindCount: state?.snapshot?.behindCount || 0,
    branches: state?.snapshot?.branches || [],
    stagedFiles: state?.snapshot?.stagedFiles || EMPTY_GIT_CHANGED_FILES,
    unstagedFiles: state?.snapshot?.unstagedFiles || EMPTY_GIT_CHANGED_FILES,
    loading: state?.loading || false,
    error: state?.error || "",
    refresh,
  };
}
