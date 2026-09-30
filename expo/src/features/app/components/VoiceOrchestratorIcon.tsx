import { Image, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";

export type VoiceOrchestrator = { id: string; name: string; icon: string };

export function VoiceOrchestratorIcon({ orchestrator, size = 40, active = false }: {
  orchestrator: VoiceOrchestrator; size?: number; active?: boolean;
}) {
  const { theme } = useVisualTheme();
  const initial = [...orchestrator.name.trim()][0] || "●";
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden",
      borderWidth: active ? 2 : 1, borderColor: active ? theme.colors.accent : theme.colors.border,
      alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceRaised }}>
      {orchestrator.icon
        ? <Image source={{ uri: orchestrator.icon }} style={{ width: "100%", height: "100%" }} />
        : <Text style={{ color: theme.colors.textPrimary, fontSize: size * .42, fontWeight: "600" }}>{initial}</Text>}
    </View>
  );
}
