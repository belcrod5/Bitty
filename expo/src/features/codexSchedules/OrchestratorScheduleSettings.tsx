import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../app/styles";
import { useVisualTheme } from "../app/theme/VisualThemeContext";
import { CodexScheduleApiError, getOrchestratorSchedule, putOrchestratorSchedule } from "./codexScheduleApi";
import { CODEX_SCHEDULE_REPEAT_OPTIONS, codexScheduleRruleToRepeat,
  type OrchestratorPeriodicSettings, type OrchestratorScheduleSnapshot } from "./codexScheduleTypes";

export function OrchestratorScheduleSettings({ orchestratorId, orchestratorName, runnerUrl, runnerToken }: {
  orchestratorId: string; orchestratorName: string; runnerUrl: string; runnerToken: string;
}) {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const [snapshot, setSnapshot] = useState<OrchestratorScheduleSnapshot | null>(null);
  const [draft, setDraft] = useState<OrchestratorPeriodicSettings | null>(null);
  const [interval, setInterval] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const requestId = useRef(0);
  const scope = JSON.stringify([orchestratorId, runnerUrl, runnerToken]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setSnapshot(null); setDraft(null); setError(""); setSaved(false);
    try {
      const next = await getOrchestratorSchedule({ runnerUrl, runnerToken }, orchestratorId);
      if (id !== requestId.current || scope !== activeScope.current) return;
      setSnapshot(next); setDraft(next.settings); setInterval(String(next.settings.intervalMinutes));
    } catch (cause) {
      if (id === requestId.current && scope === activeScope.current) setError(cause instanceof Error ? cause.message : "設定を読み込めません。");
    }
  }, [orchestratorId, runnerUrl, runnerToken, scope]);
  useEffect(() => { setBusy(false); void load(); return () => { ++requestId.current; }; }, [load]);

  const save = async () => {
    if (!snapshot || !draft || busy) return;
    if (!/^[1-9]\d{0,4}$/.test(interval) || Number(interval) > 10080) {
      setError("実行間隔は1〜10,080分の整数を入力してください。"); return;
    }
    const id = ++requestId.current;
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await putOrchestratorSchedule({ runnerUrl, runnerToken }, orchestratorId, snapshot.revision,
        { ...draft, intervalMinutes: Number(interval) });
      if (id !== requestId.current || scope !== activeScope.current) return;
      setSnapshot(next); setDraft(next.settings); setInterval(String(next.settings.intervalMinutes)); setSaved(true);
    } catch (cause) {
      if (id === requestId.current && scope === activeScope.current) setError(cause instanceof CodexScheduleApiError && cause.status === 409
        ? "別の画面で設定が変更されました。再読込して確認してください。" : cause instanceof Error ? cause.message : "保存できません。");
    } finally { if (id === requestId.current && scope === activeScope.current) setBusy(false); }
  };
  const inputStyle = { minHeight: 76, padding: 10, borderRadius: 8, color: theme.colors.groupedTextPrimary,
    backgroundColor: theme.colors.surfaceRaised, textAlignVertical: "top" as const };
  const dispatch = snapshot?.lastDispatch;
  const previousStatus = dispatch && ({ claimed: "開始待ち", fired: "開始済み", skipped: "スキップ", failed: "失敗",
    failed_uncertain_after_restart: "再起動後の状態不明" }[dispatch.status]);
  const skipReason = dispatch?.errorCode === "orchestrator_removed" ? "削除済みオーケストレーターの定期実行を停止"
    : dispatch?.errorCode === "session_busy" ? "実行中・確認待ち"
    : dispatch?.errorCode === "voice_context_reset_required" ? "セッション更新待ち" : dispatch?.errorMessage;
  const legacy = snapshot?.legacyRecurrence;
  const legacyRepeat = legacy && CODEX_SCHEDULE_REPEAT_OPTIONS.find((item) => item.value === codexScheduleRruleToRepeat(legacy.rrule))?.label;
  return <View testID="orchestrator-periodic-settings" style={styles.settingsSection}>
    <Text style={styles.settingsFooterText}>対象：{orchestratorName}</Text>
    {error ? <><Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="定期実行設定を再読込" disabled={busy} onPress={() => void load()}>
        <Text style={styles.settingsActionText}>再読込</Text></TouchableOpacity></> : null}
    {!draft ? !error ? <ActivityIndicator /> : null : <>
      <View style={styles.settingsGroup}>
        <View style={styles.settingsRow}><Text style={styles.settingsRowLabel}>定期実行を有効にする</Text>
          <Switch accessibilityLabel="定期実行を有効にする" value={draft.enabled} disabled={busy}
            onValueChange={(enabled) => { setDraft({ ...draft, enabled }); setSaved(false); }} /></View>
        <View style={[styles.settingsRow, { flexDirection: "column", alignItems: "stretch" }]}>
          <Text style={styles.settingsRowLabel}>実行間隔（分）</Text>
          <TextInput accessibilityLabel="実行間隔（分）" value={interval} keyboardType="number-pad" maxLength={5}
            editable={!busy} onChangeText={(value) => { setInterval(value); setSaved(false); }} style={{ ...inputStyle, minHeight: 44 }} />
          <Text style={styles.settingsFooterText}>1〜10,080分。60分＝1時間。実行中はスキップして次の周期へ進みます。</Text>
        </View>
        <View style={[styles.settingsRow, { flexDirection: "column", alignItems: "stretch" }]}>
          <Text style={styles.settingsRowLabel}>実行するプロンプト</Text>
          <TextInput accessibilityLabel="実行するプロンプト" value={draft.prompt} multiline editable={!busy} maxLength={24000}
            onChangeText={(prompt) => { setDraft({ ...draft, prompt }); setSaved(false); }} style={inputStyle} />
        </View>
        <View style={[styles.settingsRow, { flexDirection: "column", alignItems: "stretch" }]}>
          <Text style={styles.settingsRowLabel}>定期実行の指示</Text>
          <TextInput accessibilityLabel="定期実行の指示" value={draft.systemInstruction} multiline editable={!busy} maxLength={4000}
            onChangeText={(systemInstruction) => { setDraft({ ...draft, systemInstruction }); setSaved(false); }} style={inputStyle} />
          <Text style={styles.settingsFooterText}>学習・メモリと共通の基本指示を引き継ぎ、この定期実行のときだけ使う指示です。</Text>
        </View>
      </View>
      {snapshot && snapshot.legacyScheduleCount > 0 ? <Text style={styles.settingsFooterText}>
        旧設定{snapshot.legacyScheduleCount}件（有効{snapshot.legacyEnabledCount}件）を保持しています。保存すると旧設定を停止し、この定期実行設定だけを使います。旧設定の内容は削除しません。
      </Text> : null}
      {legacy ? <Text style={styles.settingsFooterText}>現在の旧日程：{legacyRepeat || "指定日時"}・{legacy.startLocal}（{legacy.timeZone}）。保存すると上の実行間隔へ変更します。</Text> : null}
      {snapshot?.nextOccurrenceAt ? <Text style={styles.settingsFooterText}>次回：{new Date(snapshot.nextOccurrenceAt).toLocaleString()}</Text> : null}
      {dispatch ? <Text style={styles.settingsFooterText}>前回：{previousStatus}{dispatch.errorCode ? `（${skipReason || dispatch.errorCode}）` : ""}</Text> : null}
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="定期実行設定を保存" disabled={busy} onPress={() => void save()}
        style={styles.settingsPrimaryButton}><Text style={styles.settingsPrimaryButtonText}>{busy ? "保存中…" : "保存"}</Text></TouchableOpacity>
      {saved ? <Text style={styles.settingsFooterText}>保存しました。</Text> : null}
    </>}
  </View>;
}
