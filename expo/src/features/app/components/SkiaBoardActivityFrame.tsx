import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import type { VisualTheme } from "../theme/visualThemes";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";
import { startCyberpunkPopupTransition, startStandardPopupTransition } from "./popupChatTransitions";

type FrameBadge = {
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

export function SkiaBoardActivityFrame({ badges, theme }: { badges: FrameBadge[]; theme: VisualTheme }) {
  const reduceMotion = useReduceMotionEnabled();
  const active = badges.length > 0;
  const lastBadges = useRef(badges);
  if (active) lastBadges.current = badges;
  const [present, setPresent] = useState(active);
  const generation = useRef(0);
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scaleY = useRef(new Animated.Value(1)).current;
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    if (reduceMotion === null || (!active && !present)) return;
    const current = ++generation.current;
    if (active) setPresent(true);
    const start = theme.motion.popupTransition === "flash-blink"
      ? startCyberpunkPopupTransition : startStandardPopupTransition;
    const animation = start({
      direction: active ? "open" : "close",
      durationMs: active ? 240 : 180,
      reduceMotion,
      progress,
      cardOpacity: opacity,
      cardScaleY: scaleY,
      flashOpacity,
      onFinish: (finished) => {
        if (finished && !active && current === generation.current) setPresent(false);
      },
    });
    return () => {
      generation.current += 1;
      animation.stop();
    };
  }, [active, reduceMotion, theme.motion.popupTransition]);

  if (!active && !present) return null;
  const shownBadges = active ? badges : lastBadges.current;
  const actors = Array.from(new Map(shownBadges.map((badge) => [badge.key, badge.orchestrator])).values());
  const lead = shownBadges.find((badge) => badge.status === "running") || shownBadges[0];

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { opacity }]}
      testID="skia-board-activity-frame">
      <View style={styles.edgeGlow} />
      <View style={styles.edges} />
      <Animated.View style={[styles.flash, { opacity: flashOpacity }]} />
      <SafeAreaView pointerEvents="none" style={styles.safeTop}>
        <Animated.View style={[styles.topRail, { transform: [{ scaleY }] }]}>
          <View style={styles.topRule} />
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
          <View style={styles.topRule} />
        </Animated.View>
      </SafeAreaView>
    </Animated.View>
  );
}

function createStyles(theme: VisualTheme) {
  const color = theme.colors.activityActive;
  return StyleSheet.create({
    edges: {
      position: "absolute", top: 4, right: 4, bottom: 4, left: 4,
      borderLeftWidth: 2, borderRightWidth: 2, borderBottomWidth: 2,
      borderColor: color, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    },
    edgeGlow: {
      position: "absolute", top: 2, right: 2, bottom: 2, left: 2,
      borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 7,
      borderColor: color, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, opacity: 0.45,
    },
    flash: {
      position: "absolute", top: 2, right: 2, bottom: 2, left: 2,
      borderWidth: 4, borderColor: color, borderRadius: 10,
    },
    safeTop: {
      position: "absolute", top: 0, left: 4, right: 4,
    },
    topRail: {
      flexDirection: "row", alignItems: "center",
    },
    topRule: {
      flex: 1, height: 2, backgroundColor: color,
      shadowColor: color, shadowOpacity: 0.8, shadowRadius: 5,
    },
    label: {
      maxWidth: "62%", minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5,
      paddingHorizontal: 7, paddingVertical: 4,
      borderWidth: 2, borderColor: color, borderRadius: 18,
      backgroundColor: theme.colors.floatingSurface,
      shadowColor: color, shadowOpacity: 0.55, shadowRadius: 8,
    },
    actors: { flexDirection: "row", alignItems: "center", gap: 2 },
    extraActors: { color: theme.colors.textPrimary, fontSize: 10, fontWeight: "700" },
    message: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  });
}
