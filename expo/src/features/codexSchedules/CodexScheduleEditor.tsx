import { useMemo } from "react";
import {
  Alert,
  Modal,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { OptionSelectField } from "../app/components/OptionSelectField";
import type { ReasoningEffort } from "../app/utils/settingsParsers";
import { CodexScheduleScriptPicker } from "./CodexScheduleScriptPicker";
import {
  CODEX_SCHEDULE_REPEAT_OPTIONS,
  codexScheduleRepeatToRrule,
  codexScheduleRruleToRepeat,
  codexScheduleStartLocalFromDate,
  dateFromCodexScheduleStartLocal,
  type CodexScheduleAction,
  type CodexSchedule,
  type CodexScheduleRepeat,
} from "./codexScheduleTypes";

type Props = {
  schedule: CodexSchedule | null;
  directories: readonly { path: string; displayName: string }[];
  modelOptions: readonly { value: string; label: string }[];
  thinkOptions: readonly ReasoningEffort[];
  currentThreadId: string;
  runnerUrl: string;
  runnerToken: string;
  onChange: (schedule: CodexSchedule) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
};

function combineDate(current: Date, selected: Date) {
  return new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), current.getHours(), current.getMinutes());
}

function combineTime(current: Date, selected: Date) {
  return new Date(current.getFullYear(), current.getMonth(), current.getDate(), selected.getHours(), selected.getMinutes());
}

export function CodexScheduleEditor({
  schedule,
  directories,
  modelOptions,
  thinkOptions,
  currentThreadId,
  runnerUrl,
  runnerToken,
  onChange,
  onClose,
  onDelete,
}: Props) {
  const startDate = useMemo(
    () => schedule ? dateFromCodexScheduleStartLocal(schedule.startLocal) : new Date(),
    [schedule],
  );
  if (!schedule) return null;

  const update = (patch: Partial<CodexSchedule>) => onChange({ ...schedule, ...patch });
  const updateLlmAction = (patch: Partial<Extract<CodexScheduleAction, { kind: "llm" }>>) => {
    if (schedule.action.kind === "llm") update({ action: { ...schedule.action, ...patch } });
  };
  const cwdOptions = [
    ...directories.map((directory) => ({ value: directory.path, label: directory.displayName || directory.path })),
    ...(!directories.some((directory) => directory.path === schedule.action.cwd) && schedule.action.cwd
      ? [{ value: schedule.action.cwd, label: `登録解除済み: ${schedule.action.cwd}` }]
      : []),
  ];
  const llmAction = schedule.action.kind === "llm" ? schedule.action : null;
  const scriptAction = schedule.action.kind === "script" ? schedule.action : null;
  const models = [
    ...modelOptions,
    ...(!modelOptions.some((option) => option.value === llmAction?.modelRef) && llmAction?.modelRef
      ? [{ value: llmAction.modelRef, label: llmAction.modelRef }]
      : []),
  ];
  const threadOptions = [
    { value: "", label: "新規チャット" },
    ...(currentThreadId ? [{ value: currentThreadId, label: "現在のチャット" }] : []),
    ...(llmAction?.threadId && llmAction.threadId !== currentThreadId
      ? [{ value: llmAction.threadId, label: `指定済みチャット: ${llmAction.threadId}` }]
      : []),
  ];

  const finish = onClose;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={finish}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="編集を閉じる" onPress={finish}>
            <Text style={styles.headerAction}>完了</Text>
          </TouchableOpacity>
          <Text style={styles.title}>スケジュール編集</Text>
          <View style={styles.headerSpacer} />
        </View>
        <KeyboardAwareScrollView
          testID="codex-schedule-editor-scroll"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          bottomOffset={24}
        >
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>基本</Text>
            <View style={styles.switchRow}>
              <Text style={styles.label}>有効</Text>
              <Switch accessibilityLabel="スケジュールを有効にする" value={schedule.enabled} onValueChange={(enabled) => update({ enabled })} />
            </View>
            <TextInput accessibilityLabel="スケジュール名" style={styles.input} value={schedule.name} maxLength={100} onChangeText={(name) => update({ name })} placeholder="名前" />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>日時</Text>
            <Text style={styles.label}>開始日</Text>
            <DateTimePicker
              accessibilityLabel="開始日"
              value={startDate}
              mode="date"
              display="compact"
              onChange={(_event, selected) => selected && update({ startLocal: codexScheduleStartLocalFromDate(combineDate(startDate, selected)) })}
            />
            <Text style={styles.label}>時刻</Text>
            <DateTimePicker
              accessibilityLabel="開始時刻"
              value={startDate}
              mode="time"
              display="compact"
              minuteInterval={1}
              onChange={(_event, selected) => selected && update({ startLocal: codexScheduleStartLocalFromDate(combineTime(startDate, selected)) })}
            />
            <Text style={styles.label}>繰り返し</Text>
            <OptionSelectField
              title="繰り返し"
              options={CODEX_SCHEDULE_REPEAT_OPTIONS}
              selectedValue={codexScheduleRruleToRepeat(schedule.rrule)}
              onSelect={(repeat) => update({ rrule: codexScheduleRepeatToRrule(repeat as CodexScheduleRepeat) })}
            />
            <Text style={styles.timeZone}>{schedule.timeZone}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="現在のタイムゾーンを使用"
              style={styles.secondaryButton}
              onPress={() => update({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })}
            >
              <Text style={styles.secondaryText}>現在のタイムゾーンを使用</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>実行</Text>
            <Text style={styles.label}>実行種別</Text>
            <OptionSelectField
              title="実行種別"
              options={[{ value: "llm", label: "LLM" }, { value: "script", label: "実行ファイル" }]}
              selectedValue={schedule.action.kind}
              onSelect={(kind) => update({
                action: kind === "script"
                  ? { kind: "script", cwd: schedule.action.cwd, scriptPath: "" }
                  : {
                    kind: "llm",
                    cwd: schedule.action.cwd,
                    modelRef: modelOptions[0]?.value || "",
                    reasoningEffort: thinkOptions[0] || "medium",
                    prompt: "",
                    threadId: null,
                  },
              })}
            />
            <Text style={styles.label}>ディレクトリ</Text>
            <OptionSelectField
              title="ディレクトリ"
              options={cwdOptions}
              selectedValue={schedule.action.cwd}
              onSelect={(cwd) => update({ action: schedule.action.kind === "script"
                ? { ...schedule.action, cwd, scriptPath: "" }
                : { ...schedule.action, cwd } })}
            />
            {llmAction ? (
              <>
                <Text style={styles.label}>実行先</Text>
                <OptionSelectField
                  title="実行先"
                  options={threadOptions}
                  selectedValue={llmAction.threadId || ""}
                  onSelect={(threadId) => updateLlmAction({ threadId: threadId || null })}
                />
                <Text style={styles.label}>モデル</Text>
                <OptionSelectField title="モデル" options={models} selectedValue={llmAction.modelRef} onSelect={(modelRef) => updateLlmAction({ modelRef })} />
                <Text style={styles.label}>思考レベル</Text>
                <OptionSelectField
                  title="思考レベル"
                  options={thinkOptions.map((effort) => ({ value: effort, label: effort }))}
                  selectedValue={llmAction.reasoningEffort}
                  onSelect={(reasoningEffort) => updateLlmAction({ reasoningEffort: reasoningEffort as ReasoningEffort })}
                />
              </>
            ) : (
              <>
                <Text style={styles.label}>ファイル</Text>
                <CodexScheduleScriptPicker
                  runnerUrl={runnerUrl}
                  runnerToken={runnerToken}
                  rootPath={schedule.action.cwd}
                  value={scriptAction?.scriptPath || ""}
                  onSelect={(scriptPath) => scriptAction && update({ action: { ...scriptAction, scriptPath } })}
                />
              </>
            )}
          </View>

          {llmAction ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>プロンプト</Text>
              <TextInput
                accessibilityLabel="プロンプト"
                style={[styles.input, styles.prompt]}
                value={llmAction.prompt}
                maxLength={24_000}
                multiline
                textAlignVertical="top"
                onChangeText={(prompt) => updateLlmAction({ prompt })}
              />
              <Text style={styles.count}>{llmAction.prompt.length.toLocaleString()} / 24,000</Text>
            </View>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="スケジュールを削除"
            style={styles.deleteButton}
            onPress={() => Alert.alert("スケジュールを削除しますか？", schedule.name, [
              { text: "キャンセル", style: "cancel" },
              { text: "削除", style: "destructive", onPress: () => onDelete(schedule.id) },
            ])}
          >
            <Text style={styles.deleteText}>スケジュールを削除</Text>
          </TouchableOpacity>
        </KeyboardAwareScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f1f5f9" },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#cbd5e1", backgroundColor: "#fff" },
  headerAction: { color: "#2563eb", fontSize: 16, minWidth: 48 },
  headerSpacer: { width: 48 },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  content: { padding: 16, paddingBottom: 60, gap: 16 },
  section: { padding: 14, gap: 10, backgroundColor: "#fff", borderRadius: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: "#64748b", textTransform: "uppercase" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 13, fontWeight: "600", color: "#475569" },
  input: { minHeight: 42, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 10, color: "#0f172a" },
  prompt: { minHeight: 150, paddingTop: 10 },
  count: { color: "#64748b", textAlign: "right", fontSize: 12 },
  timeZone: { color: "#334155" },
  secondaryButton: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: "#e2e8f0" },
  secondaryText: { color: "#0f172a", fontWeight: "600" },
  deleteButton: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#fff" },
  deleteText: { color: "#dc2626", fontWeight: "700" },
});
