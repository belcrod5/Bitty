import { useMemo } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";
import type { VisualTheme } from "../theme/visualThemes";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";

type ActivityBadge = {
  key: string;
  orchestrator: VoiceOrchestrator;
  status: string;
  label: string;
};

export function activityStatusText(status: string) {
  switch (status) {
    case "completed": return "完了";
    case "failed": return "失敗";
    case "interrupted": return "中断";
    case "unknown": return "状態不明";
    default: return "実行中";
  }
}

export function SkiaBoardActivityStatus({ badges, theme }: {
  badges: ActivityBadge[];
  theme: VisualTheme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (badges.length === 0) return null;
  const actors = Array.from(new Map(badges.map((badge) => [badge.key, badge.orchestrator])).values());
  const lead = badges.find((badge) => badge.status === "running") || badges[0];

  return (
    <SafeAreaView pointerEvents="none" style={styles.safeTop} testID="skia-board-activity-indicator">
      <View style={styles.label}>
        <View style={styles.actors}>
          {actors.slice(0, 2).map((actor) => (
            <View key={actor.id} testID={`skia-board-activity-actor-${actor.id}`}>
              <VoiceOrchestratorIcon orchestrator={{ ...actor, unreadCount: 0 }} size={28} active />
            </View>
          ))}
          {actors.length > 2 ? <Text style={styles.extraActors}>+{actors.length - 2}</Text> : null}
        </View>
        <Text numberOfLines={1} style={styles.message} testID="skia-board-activity-status">
          {lead.label || activityStatusText(lead.status)} · {activityStatusText(lead.status)}
        </Text>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    safeTop: {
      position: "absolute", top: 0, left: 0, right: 0, alignItems: "center",
    },
    label: {
      maxWidth: "62%", minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5,
      paddingHorizontal: 7, paddingVertical: 4,
      borderRadius: 18,
      backgroundColor: theme.colors.floatingSurface,
    },
    actors: { flexDirection: "row", alignItems: "center", gap: 2 },
    extraActors: { color: theme.colors.textPrimary, fontSize: 10, fontWeight: "700" },
    message: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  });
}
