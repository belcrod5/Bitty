import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import type { ChartBucket, DashboardPeriod } from "./learningDashboardData";

export function LearningPeriodControl({ period, offset, label, onPeriod, onOffset }: { period: DashboardPeriod; offset: number; label: string;
  onPeriod: (value: DashboardPeriod) => void; onOffset: (value: number) => void }) {
  const { theme: { colors } } = useVisualTheme();
  return <View style={styles.controls}>
    <View style={[styles.segment, { backgroundColor: colors.surfaceMuted }]}>{(["day", "week"] as const).map((value) => <Pressable key={value}
      accessibilityRole="tab" accessibilityState={{ selected: period === value }} accessibilityLabel={value === "day" ? "日別" : "週別"}
      onPress={() => onPeriod(value)} style={[styles.segmentButton, period === value && { backgroundColor: colors.surface }]}>
      <Text style={[styles.segmentText, { color: period === value ? colors.textPrimary : colors.textMuted }]}>{value === "day" ? "日別" : "週別"}</Text>
    </Pressable>)}</View>
    <View style={styles.range}>
      <Pressable accessibilityRole="button" accessibilityLabel="前の期間" onPress={() => onOffset(offset - 1)} style={styles.iconButton}>
        <Ionicons name="chevron-back" size={17} color={colors.textSecondary} /></Pressable>
      <Text style={[styles.rangeText, { color: colors.textSecondary }]}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="次の期間" accessibilityState={{ disabled: offset >= 0 }} disabled={offset >= 0}
        onPress={() => onOffset(offset + 1)} style={[styles.iconButton, { opacity: offset >= 0 ? 0.3 : 1 }]}>
        <Ionicons name="chevron-forward" size={17} color={colors.textSecondary} /></Pressable>
    </View>
  </View>;
}
export function LearningBars({ buckets, values, selected, onSelect, maximum, unit, secondaryLabel }: {
  buckets: ChartBucket[]; values: { primary: number | null; secondary?: number | null; label: string }[]; selected: string | null;
  onSelect: (key: string) => void; maximum?: number; unit: string; secondaryLabel?: string;
}) {
  const { theme: { colors } } = useVisualTheme();
  const max = maximum ?? Math.max(1, ...values.flatMap((value) => [value.primary ?? 0, value.secondary ?? 0]));
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.graphScroll}>
    <View style={styles.graph}>{buckets.map((bucket, index) => {
      const value = values[index];
      const bar = (score: number | null | undefined, color: string) => score === null || score === undefined
        ? <View style={styles.missing}><Text style={[styles.missingText, { color: colors.textMuted }]}>—</Text></View>
        : score === 0 ? <Text style={[styles.missingText, { color }]}>0</Text> : <View style={[styles.bar, { backgroundColor: color, height: Math.max(3, score / max * 100) }]} />;
      return <Pressable key={bucket.key} accessibilityRole="button" accessibilityLabel={`${bucket.label}: ${value.label}。タップして一覧を表示`}
        accessibilityState={{ selected: selected === bucket.key }} onPress={() => onSelect(bucket.key)}
        style={[styles.column, { borderBottomColor: selected === bucket.key ? colors.accent : colors.borderSubtle,
          backgroundColor: selected === bucket.key ? colors.surfaceMuted : "transparent" }]}>
        <View style={styles.barArea}>{bar(value.primary, colors.accent)}{secondaryLabel ? bar(value.secondary, colors.textSecondary) : null}</View>
        <Text style={[styles.bucketLabel, { color: selected === bucket.key ? colors.accent : colors.textMuted }]}>{bucket.label}</Text>
      </Pressable>;
    })}</View>
    <Text accessibilityElementsHidden style={[styles.unit, { color: colors.textMuted }]}>{unit}</Text>
  </ScrollView>;
}
export function LearningPager({ page, total, onPage, label }: { page: number; total: number; onPage: (page: number) => void; label: string }) {
  const { theme: { colors } } = useVisualTheme();
  const count = Math.max(1, Math.ceil(total / 5)); const current = Math.min(page, count - 1);
  if (count === 1) return null;
  return <View style={styles.pager}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}の前のページ`} disabled={current === 0} onPress={() => onPage(current - 1)} style={styles.iconButton}>
      <Ionicons name="chevron-back" size={17} color={current === 0 ? colors.textMuted : colors.accent} /></Pressable>
    <Text style={[styles.rangeText, { color: colors.textSecondary }]}>{current + 1} / {count} ページ · {total}件</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}の次のページ`} disabled={current === count - 1} onPress={() => onPage(current + 1)} style={styles.iconButton}>
      <Ionicons name="chevron-forward" size={17} color={current === count - 1 ? colors.textMuted : colors.accent} /></Pressable>
  </View>;
}
export function LearningDisclosure({ title, children, initialOpen = false }: { title: string; children: React.ReactNode; initialOpen?: boolean }) {
  const { theme: { colors } } = useVisualTheme(); const [open, setOpen] = useState(initialOpen);
  return <View style={styles.disclosure}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.disclosureButton}>
      <Text style={[styles.disclosureTitle, { color: colors.textPrimary }]}>{title}</Text>
      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.textMuted} /></Pressable>
    {open ? children : null}
  </View>;
}
const styles = StyleSheet.create({
  controls: { gap: 4, alignItems: "center" }, segment: { flexDirection: "row", borderRadius: 10, padding: 3 },
  segmentButton: { minHeight: 44, minWidth: 70, alignItems: "center", justifyContent: "center", borderRadius: 8 }, segmentText: { fontSize: 13, fontWeight: "600" },
  range: { flexDirection: "row", alignItems: "center", justifyContent: "center" }, rangeText: { flexShrink: 1, textAlign: "center", fontSize: 12, fontVariant: ["tabular-nums"] },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  graphScroll: { flexGrow: 1, paddingTop: 8 }, graph: { flex: 1, flexDirection: "row" }, column: { flex: 1, minWidth: 44, paddingHorizontal: 6, paddingVertical: 8, borderBottomWidth: 2, borderRadius: 6, gap: 8 },
  barArea: { height: 106, flexDirection: "row", gap: 4, alignItems: "flex-end", justifyContent: "center" },
  bar: { width: 11, borderTopLeftRadius: 4, borderTopRightRadius: 4 }, missing: { width: 11, alignItems: "center" }, missingText: { fontSize: 11 },
  bucketLabel: { textAlign: "center", fontSize: 10 }, unit: { fontSize: 10, position: "absolute", right: 0, top: 0 },
  pager: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, disclosure: { gap: 8 },
  disclosureButton: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, disclosureTitle: { fontSize: 14, fontWeight: "600" },
});
