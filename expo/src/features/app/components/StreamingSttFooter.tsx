import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import React, { forwardRef, memo, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { StreamingSttUsage } from "../../stt/streamingSttClient";

const GREEN = "#39ff14";
const POINTS = 38;
const FRAME_MS = 1000 / 30;

export type StreamingSttFooterHandle = {
  pushSample: (sample: number) => void;
  updateUsage: (usage: StreamingSttUsage) => void;
};

type WaveformHandle = { pushSample: (sample: number) => void };

const StreamingWaveform = memo(forwardRef<WaveformHandle>(function StreamingWaveform(_, ref) {
  const valuesRef = useRef(new Float32Array(POINTS));
  const cursorRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const lastDrawRef = useRef(0);
  const widthRef = useRef(220);
  const path = useSharedValue(Skia.Path.Make());

  const draw = useCallback((now: number) => {
    pendingRef.current = null;
    if (now - lastDrawRef.current < FRAME_MS) {
      pendingRef.current = requestAnimationFrame(draw);
      return;
    }
    lastDrawRef.current = now;
    const next = Skia.Path.Make();
    const values = valuesRef.current;
    const step = widthRef.current / POINTS;
    for (let index = 0; index < POINTS; index += 1) {
      const value = values[(cursorRef.current + index) % POINTS];
      const profile = Math.sin(Math.PI * index / (POINTS - 1));
      const level = Math.min(1, Math.sqrt(value * 5));
      const height = index < 4 || index >= POINTS - 4
        ? 3
        : 5 + profile * (12 + level * 24);
      const barWidth = Math.min(4, step * 0.7);
      next.addRRect(Skia.RRectXY(
        Skia.XYWHRect(index * step + (step - barWidth) / 2, (44 - height) / 2, barWidth, height),
        barWidth / 2,
        barWidth / 2
      ));
    }
    path.value = next;
  }, [path]);

  useImperativeHandle(ref, () => ({
    pushSample(sample) {
      valuesRef.current[cursorRef.current] = Math.max(0, Math.min(1, sample));
      cursorRef.current = (cursorRef.current + 1) % POINTS;
      if (pendingRef.current === null) pendingRef.current = requestAnimationFrame(draw);
    },
  }), [draw]);

  React.useEffect(() => () => {
    if (pendingRef.current !== null) cancelAnimationFrame(pendingRef.current);
  }, []);

  return (
    <View
      style={{ flex: 1, minWidth: 0, height: 44 }}
      onLayout={(event) => {
        widthRef.current = event.nativeEvent.layout.width;
        if (pendingRef.current === null) pendingRef.current = requestAnimationFrame(draw);
      }}
    >
      <Canvas style={{ flex: 1 }} testID="streaming-stt-waveform">
        <Path path={path} color={GREEN} />
      </Canvas>
    </View>
  );
}));

function usageLabel(usage: StreamingSttUsage | null) {
  if (!usage) return "--:-- / --m";
  const minutes = Math.floor(usage.usedSeconds / 60);
  const seconds = Math.floor(usage.usedSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} / ${Math.ceil(usage.limitSeconds / 60)}m`;
}

export const StreamingSttFooter = memo(forwardRef<StreamingSttFooterHandle, {
  finalizing: boolean;
}>(function StreamingSttFooter({ finalizing }, ref) {
  const waveformRef = useRef<WaveformHandle>(null);
  const [usage, setUsage] = useState<StreamingSttUsage | null>(null);
  const lastUsageUpdateRef = useRef(0);
  const pendingUsageRef = useRef<StreamingSttUsage | null>(null);
  const usageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    pushSample(sample) {
      waveformRef.current?.pushSample(sample);
    },
    updateUsage(next) {
      const elapsed = Date.now() - lastUsageUpdateRef.current;
      if (elapsed >= 1000) {
        lastUsageUpdateRef.current = Date.now();
        setUsage(next);
        return;
      }
      pendingUsageRef.current = next;
      if (usageTimerRef.current) return;
      usageTimerRef.current = setTimeout(() => {
        usageTimerRef.current = null;
        lastUsageUpdateRef.current = Date.now();
        setUsage(pendingUsageRef.current);
        pendingUsageRef.current = null;
      }, 1000 - elapsed);
    },
  }), []);

  React.useEffect(() => () => {
    if (usageTimerRef.current) clearTimeout(usageTimerRef.current);
  }, []);

  return (
    <View
      testID="streaming-stt-footer"
      style={{
        minHeight: 58,
        borderRadius: 14,
        backgroundColor: "#000000",
        paddingHorizontal: 12,
        paddingVertical: 7,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      {finalizing ? null : <StreamingWaveform ref={waveformRef} />}
      <Text numberOfLines={1} style={{ color: GREEN, fontSize: 12, fontWeight: "800", flexShrink: 0 }}>
        {finalizing ? "FINALIZING" : usageLabel(usage)}
      </Text>
    </View>
  );
}));
