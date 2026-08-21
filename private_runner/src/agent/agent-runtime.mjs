import { createHash } from "node:crypto";

import { createClaudeBackend } from "../claude-backend.mjs";
import { createCodexBackend } from "../codex-turn-execution.mjs";
import { createAgentService } from "./agent-service.mjs";
import { createAgentHttpHandler, createAgentWsConnection } from "./agent-transport.mjs";
import { createAgentWorkspaceAdmission } from "./agent-workspace-admission.mjs";

function historyContent(message) {
  const blocks = [];
  const text = String(message?.content || "");
  if (text) blocks.push({ type: "text", text });
  const command = message?.commandExecution;
  if (command && typeof command === "object") {
    blocks.push({
      type: "tool",
      toolCallId: String(message?.itemId || command.callId || ""),
      name: "exec_command",
      inputSummary: String(command.command || ""),
      resultSummary: String(command.outcome || ""),
      status: String(command.status || command.outcome || "completed"),
    });
  }
  return blocks;
}

export function createPrivateRunnerAgentRuntime({
  neutralEnabled,
  claudeEnabled,
  claudeBinary,
  runnerToken,
  dynamicTools,
  stores,
  createCodexClient,
  normalizeSessionId,
  findSession,
  resolveSessionDirectory,
  listSessions,
  listMessages,
  resolveCanonicalCwd,
  parseAuthToken,
  json,
  normalizeSessionListLimit,
  normalizeSessionMessagesLimit,
  readJsonBody,
}) {
  const subjectId = `runner:${createHash("sha256").update(String(runnerToken || "")).digest("hex")}`;
  const sessionStore = {
    bind: stores.bindSession,
    getBinding: stores.getSessionBinding,
    getMode: stores.getSessionMode,
    acquire: stores.acquireSessionLease,
    settle: stores.settleSessionLease,
    updateIdentity: stores.updateSessionLeaseIdentity,
    handoff: stores.handoffSessionMode,
  };

  async function resolveCodexSessionCwd(sessionRef) {
    const sessionId = normalizeSessionId(sessionRef?.nativeSessionId);
    const entry = sessionId ? await findSession(sessionId) : null;
    if (!entry) {
      const error = new Error("Codex session was not found");
      error.code = "session_not_found";
      error.backendId = "codex";
      throw error;
    }
    return resolveSessionDirectory(entry);
  }

  const codexBackend = createCodexBackend({
    enabled: neutralEnabled,
    createClient: createCodexClient,
    resolveSessionCwd: resolveCodexSessionCwd,
    dynamicTools,
    async listSessions({ cwd, limit }) {
      const page = await listSessions(cwd, { source: "all", limit });
      return {
        sessions: page.sessions.map((session) => ({
          sessionRef: { backendId: "codex", nativeSessionId: session.sessionId },
          canonicalCwd: String(session.cwd || session.directory || page.directory || ""),
          updatedAt: String(session.updatedAt || ""),
          title: String(session.firstUserMessage || ""),
          modelId: String(session.modelRef || ""),
          isSubagent: session.isSubagent === true,
          ...(session.parentSessionId
            ? { parentSessionRef: { backendId: "codex", nativeSessionId: session.parentSessionId } }
            : {}),
        })),
      };
    },
    async readHistory({ sessionRef, cursor, sinceCursor, limit }) {
      const cwd = await resolveCodexSessionCwd(sessionRef);
      const page = await listMessages(sessionRef.nativeSessionId, {
        source: "all", directory: cwd, cursor, sinceCursor, limit,
      });
      return {
        items: page.messages.map((message, index) => ({
          id: String(message.itemId || `${sessionRef.nativeSessionId}:${index}`),
          role: String(message.role || "assistant"),
          content: historyContent(message),
          ...(message.timestamp ? { createdAt: String(message.timestamp) } : {}),
          ...(message.kind ? { itemType: String(message.kind) } : {}),
        })),
        olderCursor: page.olderCursor,
        newerCursor: page.latestCursor,
        ...(page.moreAfter !== undefined ? { moreAfter: page.moreAfter } : {}),
      };
    },
  });
  const claudeBackend = createClaudeBackend({
    enabled: claudeEnabled,
    binary: claudeBinary,
    sessionStore,
  });

  let service;
  const workspaceAdmission = createAgentWorkspaceAdmission({
    store: {
      list: stores.listWorkspaces,
      approve: stores.approveWorkspace,
      revoke: stores.revokeWorkspace,
    },
    onRevoke: (workspace) => service?.cancelRunsInWorkspace(workspace),
  });
  service = createAgentService({
    backends: [codexBackend, claudeBackend],
    operationStore: { claim: stores.claimOperation, complete: stores.completeOperation },
    sessionStore,
    workspaceAdmission,
    resolveCanonicalCwd,
  });
  const httpHandler = createAgentHttpHandler({
    service, runnerToken, parseAuthToken, json, normalizeSessionListLimit,
    normalizeSessionMessagesLimit, readJsonBody, workspaceAdmission, subjectId,
  });
  return {
    service,
    workspaceAdmission,
    httpHandler,
    close: async () => Promise.allSettled([codexBackend.close(), claudeBackend.close()]),
    createWsConnection: ({ ws, sendEnvelope }) => createAgentWsConnection({
      service, workspaceAdmission, ws, sendEnvelope, subjectId,
    }),
  };
}
