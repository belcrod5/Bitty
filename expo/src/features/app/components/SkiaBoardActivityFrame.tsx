import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { BlurMask, Canvas, Group, Line, Path, Skia, SweepGradient, vec } from "@shopify/react-native-skia";
import { useDerivedValue, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import type { VisualTheme } from "../theme/visualThemes";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";
import { startCyberpunkPopupTransition, startStandardPopupTransition } from "./popupChatTransitions";
import { RAINBOW_GLOW_COLORS, RAINBOW_GLOW_DEGREES_PER_MS } from "./rainbowGlow";

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

type FrameProps = {
  badges: FrameBadge[];
  theme: VisualTheme;
  targetIndexes: number[];
  positions: SharedValue<Array<{ x: number; y: number }>>;
  boardX: SharedValue<number>;
  boardY: SharedValue<number>;
  scale: SharedValue<number>;
  cardWidth: number;
  cardHeights: number[];
};

function ActivityTargetLine({ index, positions, boardX, boardY, scale, cardWidth, cardHeights,
  width, height, startY, gradientStart, gradientEnd }: Omit<FrameProps, "badges" | "theme" | "targetIndexes"> & {
  index: number; width: number; height: number; startY: number;
  gradientStart: SharedValue<number>; gradientEnd: SharedValue<number>;
}) {
  const start = vec(width / 2, startY);
  const end = useDerivedValue(() => {
    const position = positions.value[index];
    if (!position) return start;
    const left = boardX.value + position.x * scale.value;
    const top = boardY.value + position.y * scale.value;
    const right = left + cardWidth * scale.value;
    const bottom = top + cardHeights[index] * scale.value;
    if (right < 0 || left > width || bottom < 0 || top > height) return start;
    let x = Math.max(left, Math.min(start.x, right));
    let y = Math.max(top, Math.min(start.y, bottom));
    if (x === start.x && y === start.y) y = top;
    return vec(x, y);
  });
  return (
    <Line p1={start} p2={end} style="stroke" strokeWidth={2} opacity={0.8}>
      <SweepGradient c={vec(width / 2, height / 2)} colors={RAINBOW_GLOW_COLORS}
        mode="repeat" start={gradientStart} end={gradientEnd} />
    </Line>
  );
}

export function SkiaBoardActivityFrame({ badges, theme, targetIndexes, positions, boardX, boardY,
  scale, cardWidth, cardHeights }: FrameProps) {
  const reduceMotion = useReduceMotionEnabled();
  const active = badges.length > 0;
  const lastBadges = useRef(badges);
  if (active) lastBadges.current = badges;
  const [present, setPresent] = useState(active);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [rail, setRail] = useState({ safeY: 0, middle: 0, bottom: 0 });
  const generation = useRef(0);
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scaleY = useRef(new Animated.Value(1)).current;
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const gradientStart = useSharedValue(0);
  const gradientEnd = useSharedValue(360);
  const rotation = useFrameCallback((frame) => {
    const elapsed = Math.min(frame?.timeSincePreviousFrame ?? 0, 50);
    const start = (gradientStart.value + elapsed * RAINBOW_GLOW_DEGREES_PER_MS) % 360;
    gradientStart.value = start;
    gradientEnd.value = start + 360;
  }, false);
  useEffect(() => {
    rotation.setActive((active || present) && reduceMotion === false);
    return () => rotation.setActive(false);
  }, [active, present, reduceMotion, rotation]);
  const framePath = useMemo(() => {
    const path = Skia.Path.Make();
    const railY = rail.safeY + rail.middle;
    if (size.width > 36 && size.height > 36) {
      path.moveTo(8, railY);
      path.lineTo(8, size.height - 18);
      path.quadTo(8, size.height - 8, 18, size.height - 8);
      path.lineTo(size.width - 18, size.height - 8);
      path.quadTo(size.width - 8, size.height - 8, size.width - 8, size.height - 18);
      path.lineTo(size.width - 8, railY);
      path.lineTo(8, railY);
    }
    return path;
  }, [size.width, size.height, rail.safeY, rail.middle]);

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
      testID="skia-board-activity-frame"
      onLayout={({ nativeEvent: { layout: { width, height } } }) =>
        setSize((current) => current.width === width && current.height === height ? current : { width, height })}>
      <Canvas pointerEvents="none" testID="skia-board-activity-glow" style={StyleSheet.absoluteFillObject}>
        <Group clip={Skia.XYWHRect(8, rail.safeY + rail.middle, Math.max(0, size.width - 16),
          Math.max(0, size.height - 8 - rail.safeY - rail.middle))}
          opacity={0.7}>
          <Path path={framePath} style="stroke" strokeWidth={18}>
            <SweepGradient c={vec(size.width / 2, size.height / 2)} colors={RAINBOW_GLOW_COLORS}
              mode="repeat" start={gradientStart} end={gradientEnd} />
            <BlurMask blur={8} style="normal" />
          </Path>
        </Group>
        <Path path={framePath} style="stroke" strokeWidth={2}>
          <SweepGradient c={vec(size.width / 2, size.height / 2)} colors={RAINBOW_GLOW_COLORS}
            mode="repeat" start={gradientStart} end={gradientEnd} />
        </Path>
        {targetIndexes.map((index) => (
          <ActivityTargetLine key={index} index={index} positions={positions} boardX={boardX} boardY={boardY}
            scale={scale} cardWidth={cardWidth} cardHeights={cardHeights} width={size.width} height={size.height}
            startY={rail.safeY + rail.bottom} gradientStart={gradientStart} gradientEnd={gradientEnd} />
        ))}
      </Canvas>
      <Animated.View style={[styles.flash, { opacity: flashOpacity }]} />
      <SafeAreaView pointerEvents="none" style={styles.safeTop} testID="skia-board-activity-safe-top"
        onLayout={({ nativeEvent: { layout: { y } } }) =>
          setRail((current) => current.safeY === y ? current : { ...current, safeY: y })}>
        <Animated.View style={[styles.topRail, { transform: [{ scaleY }] }]}
          testID="skia-board-activity-top-rail"
          onLayout={({ nativeEvent: { layout: { y, height } } }) => {
            const middle = y + height / 2;
            const bottom = y + height;
            setRail((current) => current.middle === middle && current.bottom === bottom
              ? current : { ...current, middle, bottom });
          }}>
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
      flex: 1, height: 2,
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
