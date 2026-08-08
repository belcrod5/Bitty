export type JsonRpcId = string | number;

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
  onCalendarToolCall?: (message: unknown) => Promise<import("../../calendar/calendarToolSpecs").CalendarToolResult<unknown>>;
  onCalendarRequestCancel?: (requestId: string) => void;
  onApprovalRequest: (request: import("../approvalFlow").ApprovalRequest) => import("../approvalFlow").ApprovalAction | Promise<import("../approvalFlow").ApprovalAction>;
  onApprovalRequestResolved?: (request: import("../approvalFlow").ApprovalRequest) => void;
  timeoutMs?: number;
  onDelta?: (delta: string, params?: unknown) => void;
  onAgentMessageCompleted?: (text: string, params?: unknown) => void;
  onThreadIdResolved?: (threadId: string) => void;
  onEvent?: (method: string, params: unknown) => void;
  onLog?: (entry: CodexAppServerLogEntry) => void;
  runnerWebSocketManager?: import("../../runnerWs/RunnerWebSocketManager").RunnerWebSocketManager;
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
  // resumeFromSeqの由来relay(watermark)のrelayId。seqはrelayインスタンススコープの
  // 独立カウンタなので、attachedのrelayIdと不一致なら「relayが作り直された」と判定する。
  resumeFromRelayId?: string;
  // lastRelaySeq前進のミラー(watermark更新用)。relayIdはattached受信前は
  // resumeFromRelayId(未指定なら空文字)のまま。
  onRelaySeqAdvance?: (params: { threadId: string; relayId: string; seq: number }) => void;
  // relay作り直し検出(attachedのrelayId不一致 or latestSeq後退)によるwatermarkの
  // latestSeqへのリセット通知。受け手はHTTP差分同期などで欠落分を穴埋めする。
  onRelayReset?: (params: { threadId: string; relayId: string; seq: number }) => void;
  runnerWebSocketManager?: import("../../runnerWs/RunnerWebSocketManager").RunnerWebSocketManager;
  onApprovalRequest: (request: import("../approvalFlow").ApprovalRequest) => import("../approvalFlow").ApprovalAction | Promise<import("../approvalFlow").ApprovalAction>;
  onApprovalRequestResolved?: (request: import("../approvalFlow").ApprovalRequest) => void;
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

export type CodexThreadSourceKind =
  | "cli"
  | "vscode"
  | "appServer"
  | "exec"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther";

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
  parentThreadId: string;
  agentRole: string;
  agentDisplayName: string;
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

export type CodexCommandExecutionInfo = {
  command: string;
  status: "running" | "completed" | "failed";
  exitCode?: number | null;
};

export type CodexThreadMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
  // app-serverが永続化したitem id。履歴page間の安定キーに使う。
  itemId?: string;
  commandExecution?: CodexCommandExecutionInfo;
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
