import { Ionicons } from "@expo/vector-icons";
import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";

type Correction = { id: string; score: number | null; reason: string; at: string; cancelledAt?: string;
  resolution?: { reason: string; itemId?: string | null } };
export type LearningEvaluation = { id: string; version: number; goal: string; score: number | null; reason: string; unknowns: string;
  at: string; period: { from: string | null; until: string | null }; scope: { orchestratorId: string }; corrections: Correction[] };
type Manage = (op: string, payload: Record<string, unknown>, reportError?: boolean) => Promise<string | null>;
const scoreText = (value: number | null) => value === null ? "未評価" : `${value} / 100`;
const dateText = (value: string) => new Date(value).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function LearningEvaluationCard({ evaluation, busy, manage }: { evaluation: LearningEvaluation; busy: boolean; manage: Manage }) {
  const { theme: { colors, tones } } = useVisualTheme();
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  const [history, setHistory] = useState(false);
  const [draft, setDraft] = useState({ score: "", reason: "" });
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const latest = [...evaluation.corrections].reverse().find((item) => !item.cancelledAt && (item.score !== null || Boolean(item.reason.trim())));
  const cancellable = evaluation.corrections.filter((item) => !item.cancelledAt
    && (!item.resolution || item.score === null && !item.reason.trim() && item.resolution.itemId === null));
  const cancellationSelection = cancellable.slice(0, 100);
  const baseline = { score: latest ? latest.score : evaluation.score, reason: latest?.reason.trim() || "" };
  const score = draft.score.trim() ? Number(draft.score.trim()) : null;
  const reason = draft.reason.trim();
  const valid = (!draft.score.trim() || /^\d{1,3}$/.test(draft.score.trim()) && score !== null && score <= 100)
    && (score !== null || Boolean(reason));
  const changed = score !== baseline.score || reason !== baseline.reason;
  const action = async (op: string, payload: Record<string, unknown>) => {
    if (inFlight.current || busy) return false;
    inFlight.current = true; setError("");
    try {
      const message = await manage(op, payload, false);
      if (message) { setError(message); return false; }
      return true;
    } finally { inFlight.current = false; }
  };
  const cancelCorrections = (items: Correction[]) => {
    const ids = items.map((item) => item.id);
    Alert.alert("訂正を取り消す", `${ids.length}件の訂正を取り消します。履歴には残ります。`, [
      { text: "戻る", style: "cancel" },
      { text: "訂正を取り消す", style: "destructive", onPress: () => { void action("correction.cancel", {
        evaluationId: evaluation.id, version: evaluation.version, correctionIds: ids,
      }); } },
    ]);
  };
  const link = (label: string, onPress: () => void, options: { disabled?: boolean; icon?: "chevron-down" | "chevron-up" | "create-outline" } = {}) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy || options.disabled}
      onPress={onPress} style={({ pressed }) => [styles.link, { opacity: busy || options.disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      {options.icon ? <Ionicons name={options.icon} size={15} color={colors.accent} /> : null}
      <Text style={[styles.linkText, { color: colors.accent }]}>{label}</Text>
    </Pressable>;
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
    <Text style={[styles.goal, { color: colors.textPrimary }]}>{evaluation.goal}</Text>
    <View style={styles.ratings}>
      <View style={[styles.rating, { backgroundColor: colors.surfaceMuted }]}>
        <Text style={[styles.caption, { color: colors.textSecondary }]}>AIの暫定評価</Text>
        <Text style={[styles.score, { color: colors.textPrimary }]}>{scoreText(evaluation.score)}</Text>
      </View>
      <View style={[styles.rating, { backgroundColor: latest ? tones.info.background : colors.surfaceMuted }]}>
        <Text style={[styles.caption, { color: latest ? tones.info.foreground : colors.textSecondary }]}>あなたの評価</Text>
        <Text style={[styles.score, { color: latest ? tones.info.foreground : colors.textMuted }]}>{latest ? scoreText(latest.score) : "未設定"}</Text>
        {latest ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{latest.resolution ? "分析に反映済み" : "次回の分析待ち"}</Text> : null}
      </View>
    </View>
    {editing ? <View style={[styles.editor, { backgroundColor: tones.info.background, borderColor: tones.info.border }]}>
      <Text style={[styles.editorTitle, { color: tones.info.foreground }]}>あなたの評価を変更</Text>
      <View style={styles.scoreInputRow}>
        <TextInput accessibilityLabel={`訂正点数: ${evaluation.goal}`} placeholder="未評価" keyboardType="numeric" maxLength={4}
          value={draft.score} onChangeText={(value) => setDraft((current) => ({ ...current, score: value }))}
          editable={!busy} placeholderTextColor={colors.textMuted}
          style={[styles.scoreInput, { color: colors.textPrimary, backgroundColor: colors.surface, borderColor: colors.border }]} />
        <Text style={[styles.caption, { color: colors.textSecondary }]}>/ 100</Text>
      </View>
      <TextInput accessibilityLabel={`訂正理由: ${evaluation.goal}`} placeholder="理由（点数なしなら必須）" value={draft.reason}
        onChangeText={(value) => setDraft((current) => ({ ...current, reason: value }))} editable={!busy} multiline maxLength={1000}
        placeholderTextColor={colors.textMuted} style={[styles.reasonInput, { color: colors.textPrimary, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {draft.score.trim() && !valid ? <Text style={[styles.caption, { color: tones.danger.foreground }]}>点数は0〜100で入力してください</Text> : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="評価を保存" disabled={busy || !valid || !changed}
          style={({ pressed }) => [styles.save, { backgroundColor: colors.accent, opacity: busy || !valid || !changed ? 0.4 : pressed ? 0.7 : 1 }]}
          onPress={() => { void (async () => {
            if (await action("correct", { evaluationId: evaluation.id, version: evaluation.version, score, reason })) {
              setEditing(false); setDraft({ score: "", reason: "" });
            }
          })(); }}><Text style={[styles.saveText, { color: colors.textOnAccent }]}>保存</Text></Pressable>
        {link("キャンセル", () => { setEditing(false); setError(""); setDraft({ score: "", reason: "" }); })}
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: tones.danger.foreground }}>{error}</Text> : null}
    </View> : link("評価を変更", () => { setDraft({ score: baseline.score === null ? "" : String(baseline.score), reason: baseline.reason }); setError(""); setEditing(true); }, { icon: "create-outline" })}
    <View style={styles.disclosures}>
      {link(details ? "根拠を閉じる" : "評価の根拠", () => setDetails((value) => !value), { icon: details ? "chevron-up" : "chevron-down" })}
      {evaluation.corrections.length ? link(`訂正履歴 · ${evaluation.corrections.length}`, () => setHistory((value) => !value), { icon: history ? "chevron-up" : "chevron-down" }) : null}
    </View>
    {details ? <View style={[styles.detail, { borderColor: colors.borderSubtle }]}>
      <Text style={[styles.body, { color: colors.textPrimary }]}>{evaluation.reason}</Text>
      {evaluation.unknowns ? <Text style={[styles.caption, { color: colors.textSecondary }]}>未確認：{evaluation.unknowns}</Text> : null}
      <Text style={[styles.caption, { color: colors.textMuted }]}>{dateText(evaluation.period.from || evaluation.at)} 〜 {dateText(evaluation.period.until || evaluation.at)}</Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>会話で観測できた希望への適合度です。無反応を満足とは判断しません。</Text>
    </View> : null}
    {history ? <View style={[styles.detail, { borderColor: colors.borderSubtle }]}>
      {cancellable.length > 1 ? link(`訂正${cancellationSelection.length}件をまとめて取消`, () => cancelCorrections(cancellationSelection)) : null}
      {[...evaluation.corrections].reverse().map((item) => <View key={item.id} style={[styles.historyRow, { borderColor: colors.borderSubtle }]}>
        <View style={styles.historyContent}>
          <Text style={[styles.body, { color: item.cancelledAt ? colors.textMuted : colors.textPrimary }]}>{scoreText(item.score)} · {item.cancelledAt ? "取消済み" : item.score === null && !item.reason.trim() && (!item.resolution || item.resolution.itemId === null) ? "入力なし・学習対象外" : item.resolution ? "反映済み" : "次回分析待ち"}</Text>
          {item.reason ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.reason}</Text> : null}
          <Text style={[styles.caption, { color: colors.textMuted }]}>{dateText(item.at)}</Text>
          {item.resolution ? <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.resolution.reason}</Text> : null}
        </View>
        {cancellable.includes(item) ? <Pressable accessibilityRole="button" accessibilityLabel={`訂正を取り消す: ${item.id}`}
          disabled={busy} onPress={() => cancelCorrections([item])} hitSlop={8} style={styles.undo}>
          <Ionicons name="arrow-undo-outline" size={17} color={colors.textSecondary} />
        </Pressable> : null}
      </View>)}
    </View> : null}
    {error && !editing ? <Text accessibilityRole="alert" style={{ color: tones.danger.foreground }}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  goal: { fontSize: 15, fontWeight: "600", lineHeight: 22 },
  ratings: { flexDirection: "row", gap: 10 }, rating: { flex: 1, padding: 12, borderRadius: 12, gap: 4 },
  caption: { fontSize: 12, lineHeight: 18 }, score: { fontSize: 21, fontWeight: "700", fontVariant: ["tabular-nums"] },
  link: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 36 }, linkText: { fontSize: 13, fontWeight: "500" },
  disclosures: { flexDirection: "row", flexWrap: "wrap", columnGap: 18 },
  detail: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 8 }, body: { fontSize: 13, lineHeight: 20 },
  editor: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 }, editorTitle: { fontSize: 13, fontWeight: "600" },
  scoreInputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  scoreInput: { borderWidth: 1, borderRadius: 8, padding: 10, minWidth: 78, fontSize: 20, fontWeight: "600" },
  reasonInput: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 48, fontSize: 13 },
  actions: { flexDirection: "row", gap: 16, alignItems: "center" }, save: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 9 }, saveText: { fontSize: 14, fontWeight: "600" },
  historyRow: { flexDirection: "row", gap: 12, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10 }, historyContent: { flex: 1, gap: 4 }, undo: { padding: 8, alignSelf: "flex-start" },
});
