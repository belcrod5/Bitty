import { useCallback } from "react";
import type {
  ConversationMessage,
  ReplyRequestSessionSnapshot,
  SttMessageMeta,
} from "../types/appTypes";

type AppendSlashCommandResultOptions = {
  sttMeta?: SttMessageMeta;
  panelId?: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
  contextUsedPct?: number | null;
};

const runningSlashCommandDetail = (commandText: string) => `slash command running: ${commandText}`;
const completedSlashCommandDetail = (commandText: string) => `slash command: ${commandText}`;
const slashCommandConversationId = (options?: AppendSlashCommandResultOptions) => (
  String(options?.panelId || "").trim()
);
const slashCommandSessionId = (options?: AppendSlashCommandResultOptions) => (
  options?.sessionSnapshot?.sessionId || options?.sessionSnapshot?.threadId
);
const slashCommandMessageOptions = (
  commandText: string,
  status: "model_processing" | "completed"
) => ({
  llmStatus: status === "model_processing" && commandText === "/compact" ? "completed" : status,
  llmStatusDetail: status === "model_processing"
    ? runningSlashCommandDetail(commandText)
    : completedSlashCommandDetail(commandText),
  llmElapsedMs: 0,
});

type UseSlashCommandResultAppenderArgs = {
  buildConversationMessage: (
    role: "user" | "assistant",
    content: string,
    options?: Partial<ConversationMessage>
  ) => ConversationMessage;
  getConversationMessages: (conversationId: string) => ConversationMessage[];
  getConversationMessagesBySessionId?: (sessionId: string) => ConversationMessage[];
  setConversationMessages: (
    conversationId: string,
    messages: ConversationMessage[],
    options?: { contextUsedPct?: number | null; isResponding?: boolean; sessionId?: string }
  ) => void;
};

export function useSlashCommandResultAppender({
  buildConversationMessage,
  getConversationMessages,
  getConversationMessagesBySessionId,
  setConversationMessages,
}: UseSlashCommandResultAppenderArgs) {
  const appendSlashCommandMessage = useCallback((
    commandText: string,
    assistantText: string,
    status: "model_processing" | "completed",
    options?: AppendSlashCommandResultOptions
  ) => {
    const conversationId = slashCommandConversationId(options);
    const sessionId = String(slashCommandSessionId(options) || "").trim();
    const sessionMessages = sessionId && getConversationMessagesBySessionId
      ? getConversationMessagesBySessionId(sessionId)
      : [];
    const currentMessages = sessionMessages.length > 0
      ? sessionMessages
      : getConversationMessages(conversationId);
    const lastMessage = currentMessages[currentMessages.length - 1];
    const previousMessage = currentMessages[currentMessages.length - 2];
    const isRunningMessageForCommand = (
      lastMessage?.role === "assistant" &&
      lastMessage.llmStatusDetail === runningSlashCommandDetail(commandText) &&
      previousMessage?.role === "user" &&
      previousMessage.content === commandText
    );
    if (status === "model_processing" && isRunningMessageForCommand) {
      setConversationMessages(conversationId, currentMessages, {
        isResponding: true,
        sessionId,
      });
      return;
    }
    const userMessage = buildConversationMessage("user", commandText, {
      sttMeta: options?.sttMeta,
    });
    const assistantMessage = buildConversationMessage("assistant", assistantText, slashCommandMessageOptions(
      commandText,
      status
    ));
    const baseMessages = status === "completed" && isRunningMessageForCommand
      ? currentMessages
      : [
          ...currentMessages,
          userMessage,
        ];
    setConversationMessages(conversationId, [
      ...baseMessages,
      assistantMessage,
    ], {
      contextUsedPct: options?.contextUsedPct,
      isResponding: status === "model_processing",
      sessionId,
    });
  }, [
    buildConversationMessage,
    getConversationMessages,
    getConversationMessagesBySessionId,
    setConversationMessages,
  ]);

  const appendSlashCommandResult = useCallback((
    commandText: string,
    assistantText: string,
    options?: AppendSlashCommandResultOptions
  ) => {
    appendSlashCommandMessage(commandText, assistantText, "completed", options);
  }, [appendSlashCommandMessage]);

  const appendSlashCommandProgress = useCallback((
    commandText: string,
    assistantText: string,
    options?: AppendSlashCommandResultOptions
  ) => {
    appendSlashCommandMessage(commandText, assistantText, "model_processing", options);
  }, [appendSlashCommandMessage]);

  return {
    appendSlashCommandResult,
    appendSlashCommandProgress,
  };
}
