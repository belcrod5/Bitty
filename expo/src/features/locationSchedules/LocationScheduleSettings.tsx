import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import * as Location from "expo-location";

import type { ReasoningEffort } from "../app/utils/settingsParsers";
import {
  DEFAULT_LOCATION_RADIUS_METERS,
  MAX_ENABLED_LOCATION_SCHEDULES,
  parseLocationScheduleRules,
  type LocationScheduleRule,
} from "./locationScheduleRules";
import { loadLocationSchedules, saveAndActivateLocationSchedules } from "./locationScheduleRuntime";
import { LocationMapPicker, type LocationMapPickerTarget } from "./LocationMapPicker";

type Props = {
  currentCwd: string;
  currentModelRef: string;
  currentReasoningEffort: ReasoningEffort;
  directories: readonly { path: string; displayName: string }[];
  modelOptions: readonly { value: string; label: string }[];
  thinkOptions: readonly ReasoningEffort[];
};

function newRule(props: Props): LocationScheduleRule {
  return {
    id: `rule_${Date.now()}_${Math.floor(Math.random() * 100_000)}`,
    enabled: false,
    startTime: "09:00",
    endTime: "10:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    latitude: Number.NaN,
    longitude: Number.NaN,
    radiusMeters: DEFAULT_LOCATION_RADIUS_METERS,
    cwd: props.currentCwd || props.directories[0]?.path || "",
    modelRef: props.currentModelRef || props.modelOptions[0]?.value || "",
    reasoningEffort: props.currentReasoningEffort || props.thinkOptions[0] || "high",
    prompt: "",
  };
}

export function LocationScheduleSettings(props: Props) {
  const [visible, setVisible] = useState(false);
  const [rules, setRules] = useState<LocationScheduleRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [mapPickerRuleId, setMapPickerRuleId] = useState<string | null>(null);

  const mapPickerRule = rules.find((rule) => rule.id === mapPickerRuleId) || null;
  const mapPickerTarget: LocationMapPickerTarget | null = mapPickerRule
    ? {
      latitude: mapPickerRule.latitude,
      longitude: mapPickerRule.longitude,
      radiusMeters: mapPickerRule.radiusMeters,
    }
    : null;

  const open = async () => {
    setBusy(true);
    setVisible(true);
    try {
      setRules(await loadLocationSchedules());
    } finally {
      setBusy(false);
    }
  };

  const update = (id: string, patch: Partial<LocationScheduleRule>) => {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
  };

  const useCurrentLocation = async (id: string) => {
    try {
      let permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== "granted") permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("位置情報の使用中権限が必要です。");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      update(id, { latitude: position.coords.latitude, longitude: position.coords.longitude });
    } catch (error) {
      Alert.alert("現在地を取得できません", error instanceof Error ? error.message : String(error));
    }
  };

  const save = async () => {
    const parsed = parseLocationScheduleRules(rules, props.modelOptions);
    if (parsed.length !== rules.length) {
      Alert.alert("入力を確認してください", "時刻、座標、半径、ディレクトリ、モデル、プロンプトのいずれかが不正です。日をまたぐ時間帯は設定できません。");
      return;
    }
    if (parsed.filter((rule) => rule.enabled).length > MAX_ENABLED_LOCATION_SCHEDULES) {
      Alert.alert("ルール数が多すぎます", `有効な位置ルールは${MAX_ENABLED_LOCATION_SCHEDULES}件までです。`);
      return;
    }
    if (parsed.some((rule) => rule.enabled && rule.radiusMeters < 100)) {
      const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
        "小さい半径",
        "100m未満のジオフェンスはiOSが出入りを検知できないことがあります。200m以上を推奨します。このまま保存しますか？",
        [
          { text: "戻る", style: "cancel", onPress: () => resolve(false) },
          { text: "保存", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      ));
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      await saveAndActivateLocationSchedules(parsed);
      setRules(parsed);
      setVisible(false);
    } catch (error) {
      Alert.alert("位置・時間実行を保存できません", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TouchableOpacity style={styles.menuButton} onPress={() => void open()}>
        <Text style={styles.menuButtonText}>位置・時間実行</Text>
      </TouchableOpacity>
      <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setVisible(false)}>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setVisible(false)} disabled={busy}>
              <Text style={styles.headerAction}>閉じる</Text>
            </TouchableOpacity>
            <Text style={styles.title}>位置・時間実行</Text>
            <TouchableOpacity onPress={() => void save()} disabled={busy}>
              <Text style={[styles.headerAction, busy && styles.disabled]}>保存</Text>
            </TouchableOpacity>
          </View>
          {busy ? <ActivityIndicator style={styles.loader} /> : null}
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.help}>設定時刻にRunnerが最後に受信した位置状態を使い、通常の新規Codex実行を開始します。</Text>
            {rules.map((rule, index) => (
              <View key={rule.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>ルール {index + 1}</Text>
                  <Switch value={rule.enabled} onValueChange={(enabled) => update(rule.id, { enabled })} />
                </View>
                <Text style={styles.label}>時間（開始を含み、終了を含まない）</Text>
                <View style={styles.row}>
                  <TextInput style={[styles.input, styles.half]} value={rule.startTime} onChangeText={(startTime) => update(rule.id, { startTime })} placeholder="09:00" />
                  <Text style={styles.separator}>〜</Text>
                  <TextInput style={[styles.input, styles.half]} value={rule.endTime} onChangeText={(endTime) => update(rule.id, { endTime })} placeholder="10:00" />
                </View>
                <Text style={styles.label}>場所</Text>
                <View style={styles.row}>
                  <TextInput style={[styles.input, styles.coordinate]} value={Number.isFinite(rule.latitude) ? String(rule.latitude) : ""} onChangeText={(value) => update(rule.id, { latitude: value.trim() ? Number(value) : Number.NaN })} keyboardType="numbers-and-punctuation" placeholder="緯度" />
                  <TextInput style={[styles.input, styles.coordinate]} value={Number.isFinite(rule.longitude) ? String(rule.longitude) : ""} onChangeText={(value) => update(rule.id, { longitude: value.trim() ? Number(value) : Number.NaN })} keyboardType="numbers-and-punctuation" placeholder="経度" />
                </View>
                <View style={styles.row}>
                  <TextInput style={[styles.input, styles.radius]} value={String(rule.radiusMeters)} onChangeText={(value) => update(rule.id, { radiusMeters: Number(value) })} keyboardType="decimal-pad" placeholder="半径(m)" />
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => void useCurrentLocation(rule.id)}>
                    <Text style={styles.secondaryButtonText}>現在地を使用</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setMapPickerRuleId(rule.id)}>
                    <Text style={styles.secondaryButtonText}>マップで選択</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.label}>ディレクトリ</Text>
                <View style={styles.pickerWrap}>
                  <Picker selectedValue={rule.cwd} onValueChange={(cwd) => update(rule.id, { cwd: String(cwd) })}>
                    {props.directories.map((directory) => <Picker.Item key={directory.path} label={directory.displayName || directory.path} value={directory.path} />)}
                    {!props.directories.some((directory) => directory.path === rule.cwd) && rule.cwd ? <Picker.Item label={rule.cwd} value={rule.cwd} /> : null}
                  </Picker>
                </View>
                <Text style={styles.label}>モデル</Text>
                <View style={styles.pickerWrap}>
                  <Picker selectedValue={rule.modelRef} onValueChange={(modelRef) => update(rule.id, { modelRef: String(modelRef) })}>
                    {props.modelOptions.map((option) => <Picker.Item key={option.value} label={option.label} value={option.value} />)}
                  </Picker>
                </View>
                <Text style={styles.label}>思考レベル</Text>
                <View style={styles.pickerWrap}>
                  <Picker selectedValue={rule.reasoningEffort} onValueChange={(reasoningEffort) => update(rule.id, { reasoningEffort })}>
                    {props.thinkOptions.map((effort) => <Picker.Item key={effort} label={effort} value={effort} />)}
                  </Picker>
                </View>
                <Text style={styles.label}>プロンプト</Text>
                <TextInput style={[styles.input, styles.prompt]} value={rule.prompt} onChangeText={(prompt) => update(rule.id, { prompt })} multiline textAlignVertical="top" placeholder="Codexへ送るユーザーメッセージ" />
                <TouchableOpacity style={styles.deleteButton} onPress={() => setRules((current) => current.filter((item) => item.id !== rule.id))}>
                  <Text style={styles.deleteText}>このルールを削除</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.addButton} onPress={() => setRules((current) => [...current, newRule(props)])}>
              <Text style={styles.addButtonText}>ルールを追加</Text>
            </TouchableOpacity>
          </ScrollView>
          <LocationMapPicker
            target={mapPickerTarget}
            onCancel={() => setMapPickerRuleId(null)}
            onConfirm={(coordinate) => {
              if (mapPickerRuleId) {
                update(mapPickerRuleId, {
                  latitude: coordinate.latitude,
                  longitude: coordinate.longitude,
                });
              }
              setMapPickerRuleId(null);
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
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  headerAction: { fontSize: 16, color: "#2563eb", minWidth: 48 },
  disabled: { opacity: 0.4 },
  loader: { marginTop: 12 },
  content: { padding: 16, paddingBottom: 60, gap: 14 },
  help: { color: "#475569", fontSize: 13, lineHeight: 19 },
  card: { padding: 14, gap: 8, borderRadius: 12, backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#cbd5e1" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a" },
  label: { marginTop: 5, fontSize: 12, fontWeight: "600", color: "#475569" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { minHeight: 40, paddingHorizontal: 10, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, backgroundColor: "#fff", color: "#0f172a" },
  half: { flex: 1 },
  separator: { color: "#64748b" },
  coordinate: { flex: 1 },
  radius: { flex: 1 },
  prompt: { minHeight: 100, paddingTop: 10 },
  pickerWrap: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff" },
  secondaryButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 14, borderRadius: 8, backgroundColor: "#e2e8f0" },
  secondaryButtonText: { color: "#0f172a", fontWeight: "600" },
  deleteButton: { alignSelf: "flex-start", paddingVertical: 8 },
  deleteText: { color: "#dc2626", fontWeight: "600" },
  addButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#0f172a" },
  addButtonText: { color: "#fff", fontWeight: "700" },
  menuButton: { minHeight: 42, justifyContent: "center", paddingHorizontal: 12, borderRadius: 8 },
  menuButtonText: { color: "#0f172a", fontSize: 14, fontWeight: "600" },
});
