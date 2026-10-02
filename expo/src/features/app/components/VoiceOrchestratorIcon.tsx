import { Image, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";

export type VoiceOrchestrator = { id: string; name: string; icon: string; unreadCount?: number };

export function VoiceOrchestratorIcon({ orchestrator, size = 40, active = false }: {
  orchestrator: VoiceOrchestrator; size?: number; active?: boolean;
}) {
  const { theme } = useVisualTheme();
  const initial = [...orchestrator.name.trim()][0] || "●";
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2,
      borderWidth: active ? 2 : 1, borderColor: active ? theme.colors.accent : theme.colors.border,
      alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
      {orchestrator.icon
        ? <Image source={{ uri: orchestrator.icon }} style={{ width: "100%", height: "100%", borderRadius: size / 2 }} />
        : <Text style={{ color: theme.colors.textPrimary, fontSize: size * .42, fontWeight: "600" }}>{initial}</Text>}
      {Boolean(orchestrator.unreadCount) && <View testID={`voice-orchestrator-unread-${orchestrator.id}`}
        style={{ position: "absolute", right: -2, top: -3, minWidth: 16, height: 16, paddingHorizontal: 3,
          borderRadius: 8, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.colors.textOnAccent, fontSize: 10, fontWeight: "700" }}>
          {orchestrator.unreadCount! > 99 ? "99+" : orchestrator.unreadCount}
        </Text>
      </View>}
    </View>
  );
}
