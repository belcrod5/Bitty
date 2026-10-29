import { Fragment } from "react";
import { Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";
import { formatOutputTokens } from "../utils/messageTokens";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";
import { VoiceTurnTrace, type VoiceTurnTraceData } from "./VoiceTurnTrace";
import { MarkdownText } from "./MarkdownText";
import { AnswerLearningDetails } from "./AnswerLearningDetails";

export type VoiceConversationMessage = {
  role: "user" | "assistant" | "system"; text: string; clientOperationId: string;
  at?: string; outputTokens?: number; sessionSwitched?: boolean;
  speakerName?: string; orchestratorId?: string; orchestrator?: VoiceOrchestrator; trace?: VoiceTurnTraceData; streaming?: boolean;
};

// Both the ordinary chat and consultation use the same transcript presentation.
export function VoiceConversationMessages({ messages, orchestratorId, learningPaused = false }: {
  messages: VoiceConversationMessage[]; orchestratorId?: string; learningPaused?: boolean;
}) {
  const { theme } = useVisualTheme();
  return <>{messages.map((message, index) => {
    const user = message.role === "user";
    const textColor = user ? theme.colors.textOnAccent : theme.colors.textPrimary;
    const time = formatMessageTimestampLabel(message.at);
    const tokenLabel = !user && Number.isSafeInteger(message.outputTokens) && Number(message.outputTokens) >= 0
      ? formatOutputTokens(message.outputTokens) : "";
    const owner = message.orchestratorId || orchestratorId;
    return <Fragment key={`${message.clientOperationId}-${message.role}-${index}`}>
      {user && message.sessionSwitched === true ? <View testID={`voice-session-switch-${message.clientOperationId}`}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.borderStrong }} />
        <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>セッション切り替え</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.borderStrong }} />
      </View> : null}
      <View style={{ alignSelf: user ? "flex-end" : "flex-start", maxWidth: message.orchestrator ? "96%" : "90%", flexDirection: "row", gap: 9 }}>
        {!user && message.orchestrator ? <VoiceOrchestratorIcon orchestrator={message.orchestrator} size={30} /> : null}
      <View style={{ flexShrink: 1, padding: 12, borderRadius: 12,
        backgroundColor: user ? theme.colors.accent : theme.colors.surfaceMuted }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <Text style={{ color: textColor, fontSize: 11 }}>{message.speakerName || (user ? "あなた" : "AI")}</Text>
          {time || tokenLabel ? <Text style={{ color: textColor, fontSize: 11 }}>
            {[time, tokenLabel].filter(Boolean).join("  ")}</Text> : null}
        </View>
        {message.streaming || message.role === "system" ? <Text selectable style={{ color: textColor, fontSize: 15, lineHeight: 23 }}>{message.text}</Text>
          : <MarkdownText content={message.text} tone={user ? "user" : "assistant"}
            textStyle={{ color: textColor, fontSize: 15, lineHeight: 23 }} containerStyle={{ width: "auto", minWidth: 0 }} resolveImageSource={() => null} />}
        {message.trace ? <VoiceTurnTrace trace={message.trace} live={message.streaming} /> : null}
        {message.role === "assistant" && owner && !message.streaming ? <AnswerLearningDetails orchestratorId={owner}
          operationId={message.clientOperationId} paused={learningPaused} /> : null}
      </View>
      </View>
    </Fragment>;
  })}</>;
}
