import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketContext";
import { useVisualTheme } from "../theme/VisualThemeContext";

type Item = { id: string; version: number; name?: string };
type Delivery = { items: Item[]; reads: Item[]; inheritedReads: Item[]; readsVerified?: boolean };
type RecordState = { key: string; status: "loading" | "ready" | "missing" | "error"; delivery?: Delivery };

export function AnswerLearningDetails({ orchestratorId, operationId, paused = false }: {
  orchestratorId: string; operationId: string; paused?: boolean;
}) {
  const manager = useRunnerWebSocketManager();
  const { theme } = useVisualTheme();
  const { colors } = theme;
  const tone = theme.tones.info;
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<RecordState | null>(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([orchestratorId, operationId]);

  useEffect(() => { setOpen(false); }, [key, paused]);
  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    if (paused) return;
    setRecord({ key, status: "loading" });
    void (async () => {
      try {
        const response = await manager.request({ channel: "agent", op: "voice.learning.delivery", payload: { orchestratorId, operationId } });
        if (cancelled) return;
        const delivery = (response.payload as { delivery?: Delivery | null })?.delivery;
        if (delivery && (!Array.isArray(delivery.items) || !Array.isArray(delivery.reads) || !Array.isArray(delivery.inheritedReads))) {
          throw new Error("Invalid delivery");
        }
        setRecord(delivery ? { key, status: "ready", delivery } : { key, status: "missing" });
      } catch {
        if (!cancelled) setRecord({ key, status: "error" });
      }
    })();
    return () => { cancelled = true; };
  }, [manager, orchestratorId, operationId, key, paused, retry]);

  const current = !paused && record?.key === key ? record : null;
  const delivery = current?.delivery;
  const count = delivery ? new Set([...delivery.items, ...delivery.reads, ...delivery.inheritedReads]
    .map((item) => JSON.stringify([item.id, item.version]))).size : null;
  const partial = !!delivery && !delivery.readsVerified;
  const active = count !== null && count > 0;
  const foreground = active || open ? tone.foreground : colors.textSecondary;
  const statusLabel = current?.status === "loading" ? "確認中" : count === null ? "記録未確認"
    : count ? `${count}件${partial ? "以上、一部記録未確認" : ""}` : partial ? "一部記録未確認" : "参照なし";
  const groups = delivery ? [
    { title: "モデルへ渡した学習", icon: "layers-outline" as const, items: delivery.items },
    { title: delivery.readsVerified ? "この回答で読んだスキル" : "スキル読取（記録未確認）", icon: "book-outline" as const, items: delivery.reads },
    { title: "以前の回答から継承", icon: "git-branch-outline" as const, items: delivery.inheritedReads },
  ] : [];

  return <View style={styles.root}>
    <Pressable accessibilityRole="button" accessibilityLabel={`回答の学習・参照詳細、${statusLabel}`}
      accessibilityHint="知識とスキルの参照記録を開閉します"
      accessibilityState={{ expanded: open && !paused, disabled: paused, busy: current?.status === "loading" }}
      disabled={paused} onPress={() => setOpen((value) => !value)}
      style={({ pressed }) => [styles.trigger, { opacity: pressed || paused ? 0.6 : 1 }]}>
      {current?.status === "loading" ? <ActivityIndicator size="small" color={foreground} />
        : <Ionicons name="library-outline" size={15} color={foreground} />}
      {active ? <View style={[styles.badge, { backgroundColor: tone.foreground }]}>
        <Text testID="answer-learning-count" style={[styles.badgeText, { color: tone.background }]}>{count}{partial ? "+" : ""}</Text>
      </View> : (count === null || partial) && current?.status !== "loading"
        ? <Text style={[styles.unknown, { color: foreground }]}>?</Text> : null}
      <Ionicons name={open && !paused ? "chevron-up" : "chevron-down"} size={10} color={foreground} />
    </Pressable>
    {open && !paused ? <View style={[styles.card, { backgroundColor: tone.background, borderColor: tone.border }]}>
      <View style={styles.header}>
        <View style={[styles.headerIcon, { backgroundColor: colors.surface }]}>
          <Ionicons name="library-outline" size={16} color={tone.foreground} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: tone.foreground }]}>学習コンテキスト</Text>
          <Text style={[styles.caption, { color: colors.textSecondary }]}>{count === null ? "この回答の参照記録"
            : partial ? `確認済み ${count}件 · 一部の読取記録は未確認` : `${count}件の知識・スキル · 重複を除く`}</Text>
        </View>
      </View>
      {current?.status === "loading" ? <Text style={[styles.message, { color: colors.textSecondary }]}>参照記録を確認中…</Text>
        : current?.status === "error" ? <View style={styles.error}>
          <Text style={[styles.message, { color: colors.textPrimary }]}>参照記録を取得できませんでした。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="参照記録を再読み込み" onPress={() => setRetry((value) => value + 1)}
            style={styles.retry}>
            <Ionicons name="refresh-outline" size={16} color={tone.foreground} />
            <Text style={[styles.retryText, { color: tone.foreground }]}>再読み込み</Text>
          </Pressable>
        </View> : !delivery ? <Text style={[styles.message, { color: colors.textSecondary }]}>参照記録は未確認です。保持期間外・忘却後の回答も含みます。</Text>
          : <>
            {groups.map((group) => <View key={group.title} style={[styles.group, { borderTopColor: tone.border }]}>
              <View style={styles.groupHeader}>
                <Ionicons name={group.icon} size={14} color={tone.foreground} />
                <Text style={[styles.groupTitle, { color: tone.foreground }]}>{group.title}</Text>
              </View>
              {group.items.length ? <View style={styles.items}>{group.items.map((item, index) => <View key={`${item.id}:${item.version}:${index}`}
                style={[styles.item, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
                <Text style={[styles.itemName, { color: colors.textPrimary }]}>{item.name || "名称未記録の学習"}</Text>
                <Text style={[styles.version, { color: colors.textSecondary }]}>v{item.version}</Text>
              </View>)}</View> : <Text style={[styles.empty, { color: colors.textSecondary }]}>{group.items === delivery.reads && partial ? "未確認" : "なし"}</Text>}
            </View>)}
            <Text style={[styles.footnote, { color: colors.textSecondary }]}>渡した情報と読取記録です。回答への影響は判定しません。</Text>
          </>}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { marginTop: 4, gap: 8 },
  trigger: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", justifyContent: "center",
    minHeight: 44, minWidth: 44, paddingHorizontal: 4, gap: 4 },
  badge: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] },
  unknown: { fontSize: 12, fontWeight: "600" },
  card: { borderRadius: 16, borderWidth: 1, borderLeftWidth: 3, padding: 14, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerIcon: { height: 32, width: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  headerText: { flex: 1, gap: 3 },
  title: { fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  caption: { fontSize: 10, lineHeight: 15 },
  message: { fontSize: 12, lineHeight: 19 },
  error: { gap: 4 },
  retry: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 44 },
  retryText: { fontSize: 12, fontWeight: "600" },
  group: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 7 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  groupTitle: { flex: 1, fontSize: 11, fontWeight: "600", lineHeight: 17 },
  items: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  item: { flexDirection: "row", alignItems: "center", maxWidth: "100%", gap: 7, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  itemName: { flexShrink: 1, fontSize: 12, lineHeight: 18 },
  version: { fontSize: 10 },
  empty: { fontSize: 11, paddingLeft: 20 },
  footnote: { fontSize: 10, lineHeight: 16 },
});
