import { useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { requestICloudCalendar, type ICloudCalendarStatus, type ICloudConnectionTest } from "../../calendar/icloudCalendarClient";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { KeyboardAvoidingView } from "../keyboardController";
import { useAppStyles } from "../styles";

export function ICloudCalendarSettingsScreen({ onBack }: { onBack: () => void }) {
  const styles = useAppStyles();
  const { runnerUrl, runnerToken } = useAppSettings();
  const [status, setStatus] = useState<ICloudCalendarStatus | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(true);
  const [tested, setTested] = useState<ICloudConnectionTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const busyRef = useRef(false);
  const activeRun = useRef(0);

  useEffect(() => {
    const current = ++version.current;
    let active = true;
    activeRun.current += 1;
    setPassword(""); setTested(null); setStatus(null); setAccount(""); setError(""); setMessage("");
    busyRef.current = false; setBusy(false);
    void requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "status").then((next) => {
      if (!active) return;
      setStatus((value) => value ?? next);
      if (version.current === current) setAccount(next.account);
    }).catch((failure) => { if (version.current === current) setError(failure instanceof Error ? failure.message : "状態を取得できませんでした。"); });
    return () => { active = false; version.current += 1; };
  }, [runnerUrl, runnerToken]);

  function edit(field: "account" | "password", value: string) {
    version.current += 1;
    if (field === "account") setAccount(value); else setPassword(value);
    setTested(null); setError(""); setMessage("");
  }
  async function run(action: (current: number) => Promise<void>) {
    if (busyRef.current) return;
    const current = version.current;
    const operation = ++activeRun.current;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(current); }
    catch (failure) { if (version.current === current) setError(failure instanceof Error ? failure.message : "iCloudへの接続に失敗しました。"); }
    finally { if (activeRun.current === operation) { busyRef.current = false; setBusy(false); } }
  }
  const button = (label: string, action: () => void, disabled = false) => <TouchableOpacity
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: busy || disabled }}
    disabled={busy || disabled} onPress={action} style={styles.settingsPrimaryButton}>
    <Text style={styles.settingsPrimaryButtonText}>{label}</Text>
  </TouchableOpacity>;
  const configured = status?.configured === true;

  return <KeyboardAvoidingView style={styles.settingsScreen} behavior={Platform.OS === "ios" ? "padding" : undefined} automaticOffset={Platform.OS === "ios"}>
    <ScrollView contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="設定に戻る" style={styles.settingsBackButton} onPress={onBack}>
        <Text style={styles.settingsBackButtonText}>‹ 設定</Text>
      </TouchableOpacity>
      <Text style={styles.settingsTitle}>iCloudカレンダー</Text>
      <View style={styles.settingsSection}><View style={styles.settingsGroup}><View style={styles.settingsInputRow}><View style={styles.settingsInputContent}>
        <Text style={styles.settingsRowLabel}>{status ? configured ? status.enabled ? "接続済み・有効" : "接続済み・無効" : "未接続" : "接続状態を確認中…"}</Text>
        {configured ? <Text style={styles.settingsRowDescription}>{status.account}</Text> : null}
        <Text style={styles.settingsRowDescription}>MacのRunnerが起動していれば、アプリを閉じている間もiCloudの予定を読み取れます（読み取り専用）。端末内・Google・Exchangeの予定は対象外です。</Text>
        <Text style={styles.settingsRowDescription}>普段のApple Account（メールアドレス）を使います。開発者アカウントは不要です。</Text>
        <Text style={styles.settingsRowDescription}>通常のApple Accountパスワードではなく、2ファクタ認証を有効にして発行した「アプリ用パスワード」を入力してください。</Text>
        <Text style={styles.settingsRowDescription}>発行手順: account.apple.com → サインインとセキュリティ → アプリ用パスワード → 生成。</Text>
        {button("Apple Accountでパスワードを発行", () => void Linking.openURL("https://account.apple.com/").catch(() => setError("Apple Accountのページを開けませんでした。")))}
        <Text style={styles.settingsRowLabel}>Apple Account（メールアドレス）</Text>
        <TextInput accessibilityLabel="Apple Account（メールアドレス）" value={account} onChangeText={(value) => edit("account", value)}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" editable={!busy} style={styles.settingsInlineInput} />
        <Text style={styles.settingsRowLabel}>アプリ用パスワード</Text>
        <TextInput accessibilityLabel="アプリ用パスワード" value={password} onChangeText={(value) => edit("password", value)}
          autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" secureTextEntry={!visible} editable={!busy} style={styles.settingsInlineInput} />
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={visible ? "パスワードを隠す" : "パスワードを表示"} onPress={() => setVisible(!visible)}>
          <Text style={styles.settingsActionText}>{visible ? "パスワードを隠す" : "パスワードを表示"}</Text>
        </TouchableOpacity>
        <Text style={styles.settingsRowDescription}>{visible ? "パスワードを表示しています。" : "パスワードを隠しています。"}空白は除去し、ハイフンは保持します。</Text>
        {button(busy ? "処理中…" : "接続をテスト", () => void run(async (current) => {
          setTested(null);
          const result = await requestICloudCalendar<ICloudConnectionTest>(runnerUrl, runnerToken, "test", {
            method: "POST", body: JSON.stringify({ account, password }),
          });
          if (version.current !== current) return;
          setTested(result); setMessage(`接続テスト成功: カレンダー${result.calendarCount}件、今後7日間の予定${result.eventCount}件${result.truncated ? "以上（一部のみ）" : ""}。保存すると有効になります。`);
        }), !account.trim() || !password.trim())}
        {button("保存して有効にする", () => void run(async (current) => {
          if (!tested || Date.parse(tested.expiresAt) <= Date.now()) { setTested(null); throw new Error("接続テストをやり直してください。"); }
          const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", {
            method: "PUT", body: JSON.stringify({ verificationToken: tested.verificationToken }),
          });
          if (version.current !== current) return;
          setStatus(next); setPassword(""); setTested(null); setMessage("iCloudカレンダーを有効にしました。");
        }), !tested)}
        {configured ? <>
          {button(status.enabled ? "iCloudカレンダーを無効にする" : "iCloudカレンダーを有効にする", () => void run(async (current) => {
            const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", { method: "PATCH", body: JSON.stringify({ enabled: !status.enabled }) });
            if (version.current === current) { setStatus(next); setMessage(next.enabled ? "iCloudカレンダーを有効にしました。" : "iCloudカレンダーを無効にしました。"); }
          }))}
          {button("iCloudの接続を解除", () => void run(async (current) => {
            const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", { method: "DELETE" });
            if (version.current === current) { setStatus(next); setPassword(""); setTested(null); setMessage("Runnerから認証情報を削除しました。"); }
          }))}
        </> : null}
        <Text style={styles.settingsRowDescription}>接続テストだけでは保存しません。保存時はRunner側で暗号化して保管し、この端末には保存しません。</Text>
        {busy ? <Text style={styles.settingsRowDescription}>iCloudへ接続しています…</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
        {message ? <Text style={styles.settingsSuccessText}>{message}</Text> : null}
      </View></View></View></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
