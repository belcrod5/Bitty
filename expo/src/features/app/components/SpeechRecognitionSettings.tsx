import { useEffect, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { getSttSettings, listSttCorrectionModels, saveSttCorrection, saveSttProvider,
  type SttCorrectionSettings, type SttProvider } from "../../stt/sttSettingsClient";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppStyles } from "../styles";
import { SettingsSelect } from "./SettingsSelect";

const PROVIDERS = [
  { value: "google", label: "Google Cloud", description: "RunnerのGoogle Cloud認証と月間上限を使用します。" },
  { value: "macos", label: "macOS標準", description: "Runner Mac上で日本語を文字起こしします。初回はMacの音声認識許可が必要です。" },
] as const;

export function SpeechRecognitionSettings() {
  const styles = useAppStyles();
  const { runnerUrl, runnerToken, autoReplyAfterStt, toggleAutoReplyAfterStt } = useAppSettings();
  const [provider, setProvider] = useState<SttProvider>("google");
  const [correction, setCorrection] = useState<SttCorrectionSettings>({ model: "gpt-6-luna", effort: "low" });
  const [models, setModels] = useState<{ modelId: string; label: string; effortOptions: string[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!runnerUrl.trim() || !runnerToken.trim()) {
      setError("Runnerに接続すると選択できます。");
      setLoading(false);
      return;
    }
    void getSttSettings(runnerUrl, runnerToken).then((saved) => {
      if (!active) return;
      setProvider(saved.provider);
      setCorrection(saved.correction);
      setError("");
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "設定を取得できませんでした。");
    }).finally(() => { if (active) setLoading(false); });
    void listSttCorrectionModels(runnerUrl, runnerToken).then((catalog) => {
      if (active) setModels(catalog.filter((model) => model.modelId && model.effortOptions?.length));
    }).catch(() => { if (active) setError("補正モデルの候補を取得できませんでした。"); });
    return () => { active = false; };
  }, [runnerUrl, runnerToken]);

  const selectProvider = async (next: SttProvider) => {
    if (loading || next === provider) return;
    setLoading(true);
    setError("");
    try {
      await saveSttProvider(runnerUrl, runnerToken, next);
      setProvider(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "音声認識の設定を保存できませんでした。";
      setError(message);
      Alert.alert("音声認識", message);
    } finally {
      setLoading(false);
    }
  };

  const selectCorrection = async (next: SttCorrectionSettings) => {
    if (loading || (next.model === correction.model && next.effort === correction.effort)) return;
    setLoading(true);
    setError("");
    try {
      await saveSttCorrection(runnerUrl, runnerToken, next);
      setCorrection(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "補正設定を保存できませんでした。";
      setError(message);
      Alert.alert("音声入力", message);
    } finally { setLoading(false); }
  };
  const currentModel = models.find((model) => model.modelId === correction.model);
  const modelOptions = models.some((model) => model.modelId === correction.model)
    ? models : [{ modelId: correction.model, label: correction.model, effortOptions: [correction.effort] }, ...models];

  return (
    <>
      <SettingsSelect
        icon="mic-outline"
        label="文字起こし方式"
        options={PROVIDERS}
        selectedValue={provider}
        onSelect={(next) => void selectProvider(next)}
        loading={loading}
        description="チャットとSkiaボードの次の録音から反映されます。"
      />
      <View style={[styles.settingsRow, styles.settingsRowDivider]}>
        <Text style={[styles.settingsRowLabel, styles.settingsRowLabelWrap]}>文字起こし後に送信</Text>
        <Switch value={autoReplyAfterStt} onValueChange={toggleAutoReplyAfterStt}
          accessibilityLabel="文字起こし後に送信" />
      </View>
      <SettingsSelect icon="sparkles-outline" label="補正モデル"
        options={modelOptions.map((model) => ({ value: model.modelId, label: model.label }))}
        selectedValue={correction.model}
        onSelect={(model) => {
          const supported = modelOptions.find((item) => item.modelId === model)?.effortOptions || [];
          void selectCorrection({ model, effort: supported.includes(correction.effort)
            ? correction.effort : supported[0] || "low" });
        }} loading={loading} description="確定した音声入力を会話の文脈で補正します。" />
      <SettingsSelect icon="options-outline" label="補正の思考量"
        options={(currentModel?.effortOptions || [correction.effort]).map((effort) => ({ value: effort, label: effort }))}
        selectedValue={correction.effort}
        onSelect={(effort) => void selectCorrection({ ...correction, effort })} loading={loading}
        showDivider={false} />
      {error ? <Text style={styles.settingsErrorText}>{error}</Text> : null}
    </>
  );
}
