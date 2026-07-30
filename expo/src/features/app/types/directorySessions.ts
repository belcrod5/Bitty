import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";

export type DirectoryMarkerColor = "none" | "gray" | "red" | "yellow" | "green" | "black";

export type RegisteredDirectoryEntry = {
  id: string;
  path: string;
  displayName: string;
  markerColor: DirectoryMarkerColor;
};

export type SessionChildTreeState = {
  loading: boolean;
  loaded: boolean;
  error: string;
  entries: LlmSessionHistoryEntry[];
};

export type DirectorySessionTreeState = {
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  loaded: boolean;
  fetchedAtMs: number;
  error: string;
  latestSessionId: string;
  nextCursor: string;
  hasMore: boolean;
  entries: LlmSessionHistoryEntry[];
  childrenByParentId: Record<string, SessionChildTreeState>;
};

export type DirectoryReadProgress = {
  completed: number;
  total: number;
};

export type DirectorySessionSyncReason =
  | "drawer_open"
  | "screen_mount"
  | "manual_refresh"
  | "auth_recovery"
  | "session_completed"
  | "registered_targets_changed";

export type DirectorySessionSyncPhase =
  | "idle"
  | "loading"
  | "refreshing"
  | "complete"
  | "partial_error"
  | "error";

export type DirectorySessionSyncState = {
  cycleId: number;
  targetRevision: number;
  requestedMode: "ensure" | "refresh";
  phase: DirectorySessionSyncPhase;
  totalCount: number;
  pendingCount: number;
  activeCount: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  supersededCount: number;
  completedCount: number;
  usableCountAfterCycle: number;
  progress: number;
  startedAtMs: number;
  completedAtMs: number;
};

export type DirectoryLoadOutcome =
  | {
    status: "success";
    directoryId: string;
    directoryPath: string;
    state: DirectorySessionTreeState;
  }
  | {
    status: "failed";
    directoryId: string;
    directoryPath: string;
    error: string;
    hasUsableData: boolean;
  }
  | {
    status: "skipped";
    directoryId: string;
    directoryPath: string;
    reason: "fresh" | "not_registered";
    hasUsableData: boolean;
  }
  | {
    status: "superseded";
    directoryId: string;
    directoryPath: string;
    reason: "newer_request" | "path_changed" | "removed" | "identity_merged";
  };

export const IDLE_DIRECTORY_SESSION_SYNC: DirectorySessionSyncState = {
  cycleId: 0,
  targetRevision: 0,
  requestedMode: "ensure",
  phase: "idle",
  totalCount: 0,
  pendingCount: 0,
  activeCount: 0,
  succeededCount: 0,
  skippedCount: 0,
  failedCount: 0,
  supersededCount: 0,
  completedCount: 0,
  usableCountAfterCycle: 0,
  progress: 1,
  startedAtMs: 0,
  completedAtMs: 0,
};
