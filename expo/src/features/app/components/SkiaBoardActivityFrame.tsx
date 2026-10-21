import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { BlurMask, Canvas, Circle, Group, Line, Path, Skia, SweepGradient, vec } from "@shopify/react-native-skia";
import { useDerivedValue, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useReduceMotionEnabled } from "../hooks/useReduceMotionEnabled";
import type { VisualTheme } from "../theme/visualThemes";
import { VoiceOrchestratorIcon, type VoiceOrchestrator } from "./VoiceOrchestratorIcon";
import { RAINBOW_GLOW_COLORS } from "./rainbowGlow";

const GLOW_PULSE_MS = 1500;
// Keep color rotation from dominating the glow pulse.
const GLOW_COLORS = [
  "#ff9fa7", "#fbab3c", "#c3bb43", "#4fd690", "#50caff", "#bdaaff", "#ff9fa7",
];

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
  targets: Array<{ index: number; badgeIndex: number; badgeCount: number }>;
  positions: SharedValue<Array<{ x: number; y: number }>>;
  boardX: SharedValue<number>;
  boardY: SharedValue<number>;
  scale: SharedValue<number>;
  cardWidth: number;
};

function ActivityRouteDot({ route, travel, offset, reduceMotion }: {
  route: SharedValue<{ startX: number; startY: number; elbowY: number; endX: number; endY: number;
    vertical: number; horizontal: number; total: number; visible: boolean }>;
  travel: SharedValue<number>;
  offset: number;
  reduceMotion: boolean;
}) {
  const point = useDerivedValue(() => {
    const { startX, startY, elbowY, endX, endY, vertical, horizontal, total, visible } = route.value;
    if (!visible || total === 0) return vec(-20, -20);
    const distance = ((reduceMotion ? 0 : travel.value) + total * offset) % total;
    if (distance < vertical) return vec(startX, startY + distance);
    if (distance < vertical + horizontal) {
      return vec(startX + Math.sign(endX - startX) * (distance - vertical), elbowY);
    }
    return vec(endX, elbowY + Math.sign(endY - elbowY) * (distance - vertical - horizontal));
  });
  return <>
    <Circle c={point} r={7} color="#ffffff" opacity={0.55}><BlurMask blur={6} /></Circle>
    <Circle c={point} r={2.5} color="#ffffff" />
  </>;
}

function ActivityTargetLine({ target, positions, boardX, boardY, scale, cardWidth,
  width, height, start, gradientStart, gradientEnd, travel, reduceMotion }: Omit<FrameProps,
  "badges" | "theme" | "targets"> & {
  target: FrameProps["targets"][number]; width: number; height: number; start: { x: number; y: number };
  gradientStart: SharedValue<number>; gradientEnd: SharedValue<number>;
  travel: SharedValue<number>; reduceMotion: boolean;
}) {
  const route = useDerivedValue(() => {
    const position = positions.value[target.index];
    const endX = position ? boardX.value + (position.x + cardWidth + 2
      - (target.badgeCount - target.badgeIndex - 1) * 54) * scale.value : 0;
    const endY = position ? boardY.value + (position.y - 3) * scale.value : 0;
    const badgeRadius = 18 * scale.value;
    const elbowY = start.y + 28;
    const vertical = elbowY - start.y;
    const horizontal = Math.abs(endX - start.x);
    return { startX: start.x, startY: start.y, elbowY, endX, endY, vertical, horizontal,
      total: vertical + horizontal + Math.abs(endY - elbowY),
      visible: !!position && endX >= -badgeRadius && endX <= width + badgeRadius
        && endY >= -badgeRadius && endY <= height + badgeRadius };
  });
  const top = useDerivedValue(() => vec(route.value.startX, route.value.startY));
  const first = useDerivedValue(() => vec(route.value.startX, route.value.elbowY));
  const second = useDerivedValue(() => vec(route.value.endX, route.value.elbowY));
  const end = useDerivedValue(() => vec(route.value.endX, route.value.endY));
  const opacity = useDerivedValue(() => route.value.visible ? 0.75 : 0);
  return (
    <Group opacity={opacity}>
      <Line p1={top} p2={first} style="stroke" strokeWidth={2}>
        <SweepGradient c={vec(width / 2, height / 2)} colors={RAINBOW_GLOW_COLORS}
          mode="repeat" start={gradientStart} end={gradientEnd} />
      </Line>
      <Line p1={first} p2={second} style="stroke" strokeWidth={2}>
        <SweepGradient c={vec(width / 2, height / 2)} colors={RAINBOW_GLOW_COLORS}
          mode="repeat" start={gradientStart} end={gradientEnd} />
      </Line>
      <Line p1={second} p2={end} style="stroke" strokeWidth={2}>
        <SweepGradient c={vec(width / 2, height / 2)} colors={RAINBOW_GLOW_COLORS}
          mode="repeat" start={gradientStart} end={gradientEnd} />
      </Line>
      {[0, 1 / 3, 2 / 3].map((offset) => (
        <ActivityRouteDot key={offset} route={route} travel={travel} offset={offset} reduceMotion={reduceMotion} />
      ))}
    </Group>
  );
}

export function SkiaBoardActivityFrame({ badges, theme, targets, positions, boardX, boardY,
  scale, cardWidth }: FrameProps) {
  const reduceMotion = useReduceMotionEnabled();
  const active = badges.length > 0;
  const lastBadges = useRef(badges);
  if (active) lastBadges.current = badges;
  const [present, setPresent] = useState(active);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [rail, setRail] = useState({ safeY: 0, topX: 0, topY: 0 });
  const [labelRect, setLabelRect] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const generation = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const gradientStart = useSharedValue(0);
  const gradientEnd = useSharedValue(360);
  const glowWidth = useSharedValue(23);
  const glowBlur = useSharedValue(9.5);
  const glowOpacity = useSharedValue(0.75);
  const pulseTime = useSharedValue(0);
  const travel = useSharedValue(0);
  const rotation = useFrameCallback((frame) => {
    const elapsed = Math.min(frame?.timeSincePreviousFrame ?? 0, 50);
    const start = (gradientStart.value + elapsed * 0.72) % 360;
    gradientStart.value = start;
    gradientEnd.value = start + 360;
    pulseTime.value = (pulseTime.value + elapsed) % GLOW_PULSE_MS;
    const pulse = (Math.sin(pulseTime.value * 2 * Math.PI / GLOW_PULSE_MS) + 1) / 2;
    glowWidth.value = 14 + pulse * 18;
    glowBlur.value = 6 + pulse * 7;
    glowOpacity.value = 0.55 + pulse * 0.4;
    travel.value += elapsed * 0.14;
  }, false);
  useEffect(() => {
    rotation.setActive((active || present) && reduceMotion === false);
    return () => rotation.setActive(false);
  }, [active, present, reduceMotion, rotation]);
  const framePath = useMemo(() => {
    const path = Skia.Path.Make();
    if (size.width > 0 && size.height > 0) {
      path.moveTo(0, 0);
      path.lineTo(size.width, 0);
      path.lineTo(size.width, size.height);
      path.lineTo(0, size.height);
      path.close();
    }
    return path;
  }, [size.width, size.height]);
  const labelPath = useMemo(() => {
    const path = Skia.Path.Make();
    if (labelRect.width > 0 && labelRect.height > 0) {
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(rail.topX + labelRect.x,
        rail.safeY + rail.topY + labelRect.y,
        labelRect.width, labelRect.height), 18, 18));
    }
    return path;
  }, [labelRect, rail.safeY, rail.topX, rail.topY]);

  useEffect(() => {
    if (reduceMotion === null || (!active && !present)) return;
    const current = ++generation.current;
    if (active) setPresent(true);
    const animation = Animated.timing(opacity, {
      toValue: active ? 1 : 0,
      duration: reduceMotion ? 0 : 220,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !active && current === generation.current) setPresent(false);
    });
    return () => {
      generation.current += 1;
      animation.stop();
    };
  }, [active, reduceMotion, opacity]);

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
        <Group clip={Skia.XYWHRect(0, 0, size.width, size.height)}>
          {[framePath, labelPath].map((path, index) => (
            <Group key={index}>
              <Group opacity={glowOpacity}>
                <Path path={path} style="stroke" strokeWidth={glowWidth}>
                  <SweepGradient c={vec(size.width / 2, size.height / 2)} colors={GLOW_COLORS}
                    mode="repeat" start={gradientStart} end={gradientEnd} />
                  <BlurMask blur={glowBlur} style="normal" />
                </Path>
              </Group>
              <Path path={path} style="stroke" strokeWidth={2}>
                <SweepGradient c={vec(size.width / 2, size.height / 2)} colors={RAINBOW_GLOW_COLORS}
                  mode="repeat" start={gradientStart} end={gradientEnd} />
              </Path>
            </Group>
          ))}
        </Group>
        {labelRect.width > 0 && labelRect.height > 0 ? targets.map((target) => (
          <ActivityTargetLine key={`${target.index}:${target.badgeIndex}`} target={target}
            positions={positions} boardX={boardX} boardY={boardY} scale={scale} cardWidth={cardWidth}
            width={size.width} height={size.height}
            start={{ x: rail.topX + labelRect.x + labelRect.width / 2,
              y: rail.safeY + rail.topY + labelRect.y + labelRect.height }}
            gradientStart={gradientStart} gradientEnd={gradientEnd} travel={travel}
            reduceMotion={reduceMotion !== false} />
        )) : null}
      </Canvas>
      <SafeAreaView pointerEvents="none" style={styles.safeTop} testID="skia-board-activity-safe-top"
        onLayout={({ nativeEvent: { layout: { y } } }) =>
          setRail((current) => current.safeY === y ? current : { ...current, safeY: y })}>
        <View style={styles.topRail}
          testID="skia-board-activity-top-rail"
          onLayout={({ nativeEvent: { layout: { x, y } } }) => {
            setRail((current) => current.topX === x && current.topY === y
              ? current : { ...current, topX: x, topY: y });
          }}>
          <View style={styles.topRule} />
          <View style={styles.label} onLayout={({ nativeEvent: { layout } }) =>
            setLabelRect((current) => current.x === layout.x && current.y === layout.y
              && current.width === layout.width && current.height === layout.height ? current : layout)}>
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
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    safeTop: {
      position: "absolute", top: 0, left: 0, right: 0,
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
      borderRadius: 18,
      backgroundColor: theme.colors.floatingSurface,
    },
    actors: { flexDirection: "row", alignItems: "center", gap: 2 },
    extraActors: { color: theme.colors.textPrimary, fontSize: 10, fontWeight: "700" },
    message: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  });
}
