import { randomUUID } from "expo-crypto";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import type { CodexScheduleSettingsProps } from "./CodexScheduleSettings.contract";
import { CodexScheduleApiError, getCodexSchedules, putCodexSchedules } from "./codexScheduleApi";
import { CodexScheduleEditor } from "./CodexScheduleEditor";
import {
  CODEX_SCHEDULE_REPEAT_OPTIONS,
  codexScheduleDefinitionOnly,
  codexScheduleRruleToRepeat,
  codexScheduleStartLocalFromDate,
  dateFromCodexScheduleStartLocal,
  parseCodexScheduleDefinition,
  type CodexSchedule,
} from "./codexScheduleTypes";

function newSchedule(props: CodexScheduleSettingsProps): CodexSchedule {
  const start = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000);
  return {
    id: randomUUID(),
    name: "",
    enabled: true,
    startLocal: codexScheduleStartLocalFromDate(start),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    rrule: null,
    action: {
      kind: "llm",
      cwd: props.currentCwd || props.directories[0]?.path || "",
      modelRef: props.currentModelRef || props.modelOptions[0]?.value || "",
      reasoningEffort: props.currentReasoningEffort,
      prompt: "",
      threadId: null,
    },
    nextOccurrenceAt: null,
    lastDispatch: null,
  };
}

function savedShape(schedules: readonly CodexSchedule[]) {
  return JSON.stringify(schedules.map(codexScheduleDefinitionOnly));
}

function scheduleSubtitle(schedule: CodexSchedule) {
  if (!schedule.enabled) return "停止中";
  if (schedule.nextOccurrenceAt) {
    const repeat = CODEX_SCHEDULE_REPEAT_OPTIONS.find((option) => option.value === codexScheduleRruleToRepeat(schedule.rrule))?.label;
    const next = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: schedule.timeZone,
    }).format(new Date(schedule.nextOccurrenceAt));
    return `${repeat}・次回 ${next}`;
  }
  if (schedule.lastDispatch?.status === "failed" || schedule.lastDispatch?.status === "failed_uncertain_after_restart") {
    return "発火失敗";
  }
  return schedule.rrule === null && schedule.lastDispatch ? "実行済み" : "次回未定";
}

export function CodexScheduleSettings(props: CodexScheduleSettingsProps) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [schedules, setSchedules] = useState<CodexSchedule[]>([]);
  const [savedSchedules, setSavedSchedules] = useState<CodexSchedule[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingSchedule = schedules.find((schedule) => schedule.id === editingId) || null;
  const dirty = useMemo(() => savedShape(schedules) !== savedShape(savedSchedules), [savedSchedules, schedules]);

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const snapshot = await getCodexSchedules(props);
      setRevision(snapshot.revision);
      setSchedules(snapshot.schedules);
      setSavedSchedules(snapshot.schedules);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const open = () => {
    setVisible(true);
    void load();
  };

  const close = () => {
    if (!dirty) {
      setVisible(false);
      return;
    }
    Alert.alert("未保存の変更を破棄しますか？", "スケジュールの変更は保存されません。", [
      { text: "編集を続ける", style: "cancel" },
      { text: "破棄", style: "destructive", onPress: () => setVisible(false) },
    ]);
  };

  const save = async () => {
    try {
      if (schedules.length > 100) throw new Error("スケジュールは100件までです。");
      const definitions = schedules.map((schedule) => parseCodexScheduleDefinition(codexScheduleDefinitionOnly(schedule)));
      const now = Date.now();
      if (definitions.some((schedule) => schedule.enabled && schedule.rrule === null &&
        dateFromCodexScheduleStartLocal(schedule.startLocal).getTime() <= now)) {
        throw new Error("一回のみの日時は現在より未来にしてください。");
      }
    } catch (error) {
      Alert.alert("入力を確認してください", error instanceof Error ? error.message : String(error));
      return;
    }
    setSaving(true);
    try {
      const snapshot = await putCodexSchedules(props, revision, schedules);
      setRevision(snapshot.revision);
      setSchedules(snapshot.schedules);
      setSavedSchedules(snapshot.schedules);
    } catch (error) {
      if (error instanceof CodexScheduleApiError && error.code === "revision_conflict") {
        Alert.alert("別の端末で更新されています", "最新の一覧を再読込して、変更内容を確認してください。", [
          { text: "閉じる", style: "cancel" },
          { text: "再読込", onPress: () => void load() },
        ]);
      } else {
        Alert.alert("スケジュールを保存できません", error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const updateSchedule = (next: CodexSchedule) => {
    setSchedules((current) => current.map((schedule) => schedule.id === next.id ? next : schedule));
  };

  return (
    <>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="スケジュール実行" style={styles.menuButton} onPress={open}>
        <Text style={styles.menuButtonText}>スケジュール実行</Text>
      </TouchableOpacity>
      <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="スケジュールを閉じる" onPress={close} disabled={saving}>
              <Text style={styles.headerAction}>閉じる</Text>
            </TouchableOpacity>
            <Text style={styles.title}>スケジュール実行</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="スケジュールを追加"
              disabled={loading || saving || schedules.length >= 100}
              onPress={() => {
                const schedule = newSchedule(props);
                setSchedules((current) => [...current, schedule]);
                setEditingId(schedule.id);
              }}
            >
              <Text style={[styles.add, (loading || saving || schedules.length >= 100) && styles.disabled]}>＋</Text>
            </TouchableOpacity>
          </View>
          {loading ? <ActivityIndicator accessibilityLabel="スケジュールを読込中" style={styles.loader} /> : null}
          {!loading && loadError ? (
            <View style={styles.failure}>
              <Text style={styles.failureText}>{loadError}</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => void load()} style={styles.retryButton}>
                <Text style={styles.retryText}>再試行</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {!loading && !loadError ? (
            <ScrollView contentContainerStyle={styles.content}>
              {schedules.length === 0 ? <Text style={styles.empty}>スケジュールはありません。</Text> : null}
              {schedules.map((schedule) => (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${schedule.name || "名称未入力"}を編集`}
                  key={schedule.id}
                  style={styles.row}
                  onPress={() => setEditingId(schedule.id)}
                >
                  <Switch
                    accessibilityLabel={`${schedule.name || "名称未入力"}の有効状態`}
                    value={schedule.enabled}
                    onValueChange={(enabled) => updateSchedule({ ...schedule, enabled })}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{schedule.name || "名称未入力"}</Text>
                    <Text style={styles.subtitle}>{scheduleSubtitle(schedule)}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
          {!loadError ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="スケジュールを保存"
              style={[styles.saveButton, (!dirty || saving || loading) && styles.disabled]}
              disabled={!dirty || saving || loading}
              onPress={() => void save()}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>保存</Text>}
            </TouchableOpacity>
          ) : null}
          <CodexScheduleEditor
            schedule={editingSchedule}
            directories={props.directories}
            modelOptions={props.modelOptions}
            thinkOptions={props.thinkOptions}
            currentThreadId={props.currentThreadId}
            runnerUrl={props.runnerUrl}
            runnerToken={props.runnerToken}
            onChange={updateSchedule}
            onClose={() => setEditingId(null)}
            onDelete={(id) => {
              setSchedules((current) => current.filter((schedule) => schedule.id !== id));
              setEditingId(null);
            }}
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#cbd5e1", backgroundColor: "#fff" },
  headerAction: { fontSize: 16, color: "#2563eb", minWidth: 48 },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  add: { fontSize: 28, color: "#2563eb", minWidth: 48, textAlign: "right" },
  loader: { marginTop: 24 },
  content: { padding: 16, paddingBottom: 100, gap: 10 },
  empty: { color: "#64748b", textAlign: "center", marginTop: 40 },
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#cbd5e1" },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: "#0f172a", fontSize: 16, fontWeight: "700" },
  subtitle: { color: "#64748b", fontSize: 13, flexShrink: 1 },
  chevron: { color: "#94a3b8", fontSize: 24 },
  failure: { padding: 24, gap: 16, alignItems: "center" },
  failureText: { color: "#b91c1c", textAlign: "center" },
  retryButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: "#e2e8f0" },
  retryText: { color: "#0f172a", fontWeight: "700" },
  saveButton: { position: "absolute", left: 16, right: 16, bottom: 16, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#2563eb" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.4 },
  menuButton: { minHeight: 42, justifyContent: "center", paddingHorizontal: 12, borderRadius: 8 },
  menuButtonText: { color: "#0f172a", fontSize: 14, fontWeight: "600" },
});
