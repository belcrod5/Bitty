import { createContext, useContext, type ReactNode } from "react";
import type {
  ConversationMessage,
  SessionExecutionFact,
} from "../types/appTypes";
import type {
  DirectoryPickerEntry,
  LlmSessionSource,
} from "../hooks/useLlmSessionExplorer";
import type {
  DirectoryMarkerColor,
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
} from "../components/AppDrawer";

export type ConversationContextValue = {
  conversationMessages: ConversationMessage[];
  llmSessionRestoreLoading: boolean;
  selectedSessionExecutionFact: SessionExecutionFact | null;
  selectedThreadStatusType: string;
  selectedSessionWaitingApproval: boolean;
  waitingApprovalResumeLoading: boolean;
  waitingApprovalResumeStatusText: string;
  directorySelectOpen: boolean;
  selectedDirectoryLabel: string;
  directoryExplorerPathLabel: string;
  directoryExplorerHasParent: boolean;
  directoryExplorerLoading: boolean;
  directoryExplorerError: string;
  directoryExplorerEntries: DirectoryPickerEntry[];
  llmSessionRestoreError: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, DirectoryMarkerColor>;
  selectedLlmSessionId: string;
  hasSelectedDirectory: boolean;
  selectedDirectoryDisplayName: string;
  selectedSessionMarkerColor: DirectoryMarkerColor;
  selectedSessionTitle: string;
  selectedDirectoryPath: string;
  reply: string;
  transcript: string;
  systemPrompt: string;
  canSend: boolean;
  replyLoading: boolean;
  sttLoading: boolean;
  startNewSession: (params?: { directory?: string }) => void;
  setDirectorySelectOpen: (open: boolean) => void;
  goDirectoryParent: () => void;
  goDirectoryRoot: () => void;
  selectCurrentDirectory: () => void;
  openDirectoryEntry: (path: string) => void;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  refreshRegisteredDirectorySessions: () => Promise<void>;
  markSessionRead: (
    sessionId: string,
    source: LlmSessionSource,
    directory: string
  ) => void;
  markSelectedSessionUnread: () => void;
  reloadSelectedSession: () => void;
  resumeWaitingApprovalSession: () => void;
  renameSelectedDirectory: (nextDisplayName: string) => void;
  renameSelectedSessionTitle: (nextTitle: string) => void;
  selectSelectedSessionMarkerColor: (nextMarkerColor: DirectoryMarkerColor) => void;
  removeSelectedDirectory: () => void;
  renameDirectoryForPath: (directoryPath: string, nextDisplayName: string) => void;
  renameSessionTitleForSession: (sessionId: string, nextTitle: string) => void;
  selectSessionMarkerColorForSession: (sessionId: string, nextMarkerColor: DirectoryMarkerColor) => void;
  removeDirectoryForPath: (directoryPath: string) => void;
  markSessionUnread: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory: string;
  }) => void;
  showChatBottomToast: (role: "user" | "assistant", rawText: string) => void;
  setTranscript: (value: string) => void;
  setSystemPrompt: (value: string) => void;
  sendReplyRequest: () => void;
  sendReplyTranscript: () => void;
  sendReplyRequestForPanelWithTranscript: (panelId: string, transcript: string) => Promise<void>;
  sendReplyTranscriptForPanel: (panelId: string, transcript?: string) => Promise<void>;
  cancelReplyRequestForPanel: (panelId: string) => void;
  cancelCodexQueuedTurnForMessage: (params: {
    queuedTurnId: string;
    messageId: string;
    panelId?: string;
  }) => Promise<void>;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

type ConversationProviderProps = {
  value: ConversationContextValue;
  children: ReactNode;
};

export function ConversationProvider({ value, children }: ConversationProviderProps) {
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversation() {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error("useConversation must be used within ConversationProvider");
  }
  return context;
}
