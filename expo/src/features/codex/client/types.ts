export type JsonRpcId = number;

export type JsonRpcSuccess = {
  id: JsonRpcId;
  result: any;
};

export type JsonRpcFailure = {
  id: JsonRpcId;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type JsonRpcIncoming = Record<string, unknown>;

export type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export const NEAR_UNLIMITED_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
export const COMPACT_ASYNC_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000; // 30m

export type CodexThreadStartResponse = {
  thread?: {
    id?: string;
  };
};

export type CodexThreadResumeResponse = {
  thread?: {
    id?: string;
  };
};

export type CodexTurnStartResponse = {
  turn?: {
    id?: string;
  };
};

export type CodexAppServerLogEntry = {
  stage: string;
  method?: string;
  id?: number;
  readyState?: number;
  message?: string;
};

export type CodexAppServerTurnOptions = {
  wsUrl: string;
  wsToken?: string;
  traceId?: string;
  inputText: string;
  cwd?: string;
  threadId?: string;
  strictThreadResume?: boolean;
  serviceName?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  approvalPolicy?: "never" | "on-request";
  onApprovalRequest: (request: import("../approvalFlow").ApprovalRequest) => import("../approvalFlow").ApprovalAction | Promise<import("../approvalFlow").ApprovalAction>;
  timeoutMs?: number;
  onDelta?: (delta: string, params?: unknown) => void;
  onThreadIdResolved?: (threadId: string) => void;
  onEvent?: (method: string, params: unknown) => void;
  onLog?: (entry: CodexAppServerLogEntry) => void;
};

export type CodexAppServerTurnResult = {
  threadId: string;
  turnId: string;
  reply: string;
  contextUsage: CodexContextUsage | null;
};

export type CodexAppServerTurnSession = {
  promise: Promise<CodexAppServerTurnResult>;
  interrupt: () => Promise<void>;
};

export type CodexAppServerRelayObserverLogEntry = {
  stage: string;
  message?: string;
  readyState?: number;
};

export type CodexAppServerRelayObserverOptions = {
  wsUrl: string;
  wsToken?: string;
  threadId: string;
  resumeFromSeq?: number;
  onApprovalRequest: (request: import("../approvalFlow").ApprovalRequest) => import("../approvalFlow").ApprovalAction | Promise<import("../approvalFlow").ApprovalAction>;
  onEvent?: (method: string, params: unknown) => void;
  onDelta?: (delta: string, params?: unknown) => void;
  onAgentMessageCompleted?: (text: string, params?: unknown) => void;
  onTurnCompleted?: (params: unknown) => void;
  onLog?: (entry: CodexAppServerRelayObserverLogEntry) => void;
};

export type CodexAppServerRelayObserverSession = {
  close: () => void;
};

export type CodexContextUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  contextWindowTokens: number;
  usedRatio: number;
  usedPct: number;
  model: string;
};

export type CodexAppServerProbeResult = {
  userAgent: string;
  codexHome: string;
  platformOs: string;
};

export type CodexWebSocketHandshakeProbeResult = {
  opened: true;
  readyStateAtOpen: number;
};

export type CodexThreadSourceKind = "cli" | "vscode" | "appServer" | "exec";

export type CodexSessionState =
  | "empty"
  | "running"
  | "waiting_on_approval"
  | "completed"
  | "interrupted"
  | "failed"
  | "system_error"
  | "idle"
  | "unknown";

export type CodexThreadStatusType = "active" | "idle" | "notLoaded" | "systemError" | "unknown";

export type CodexThreadListEntry = {
  threadId: string;
  preview: string;
  modelProvider: string;
  sourceKind: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  contextUsedPct: number | null;
};

export type CodexThreadListResult = {
  data: CodexThreadListEntry[];
  nextCursor: string;
  backwardsCursor: string;
};

export type CodexThreadMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
};

export type CodexThreadReadResult = {
  threadId: string;
  preview: string;
  modelProvider: string;
  sourceKind: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messages: CodexThreadMessage[];
  contextUsedPct: number | null;
  sessionState: CodexSessionState;
  threadStatusType: CodexThreadStatusType;
  waitingOnApproval: boolean;
  latestTurnStatus: string;
  hasRunningTurn: boolean;
  runningTurn: {
    status: string;
    summary: string;
    startedAt: string;
    updatedAt: string;
  } | null;
};

export type CodexThreadCompactResult = {
  threadId: string;
  method: "thread/compact/start" | "thread/compact";
  accepted: boolean;
};
