import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { requestICloudCalendar, type ICloudCalendarStatus, type ICloudConnectionTest } from "../../calendar/icloudCalendarClient";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { KeyboardAvoidingView } from "../keyboardController";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";

export function ICloudCalendarSettingsScreen({ onBack }: { onBack: () => void }) {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const { runnerUrl, runnerToken } = useAppSettings();
  const [status, setStatus] = useState<ICloudCalendarStatus | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
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
  const configured = status?.configured === true;

  return <KeyboardAvoidingView style={styles.settingsScreen} behavior={Platform.OS === "ios" ? "padding" : undefined} automaticOffset={Platform.OS === "ios"}>
    <ScrollView contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="設定に戻る" style={styles.settingsBackButton} onPress={onBack}>
        <Text style={styles.settingsBackButtonText}>‹ 設定</Text>
      </TouchableOpacity>
      <Text style={styles.settingsTitle}>iCloudカレンダー</Text>
      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}><Text style={styles.settingsSectionTitle}>接続</Text></View>
        <View style={styles.settingsGroup}>
          <View style={[styles.settingsRow, configured && styles.settingsRowDivider]}>
            <Ionicons name="cloud-outline" size={22} color={theme.colors.controlAccent} />
            <View style={styles.settingsRowLabelWrap}>
              <Text style={styles.settingsRowLabel}>{status ? configured ? status.enabled ? "接続済み・有効" : "接続済み・無効" : "未接続" : "接続状態を確認中…"}</Text>
              <Text style={styles.settingsRowDescription}>{configured ? status.account : "iCloudの予定をRunnerから読み取ります"}</Text>
            </View>
          </View>
          {configured ? <>
            <View style={[styles.settingsRow, styles.settingsRowDivider]}>
              <Ionicons name="calendar-outline" size={22} color={theme.colors.controlTextPrimary} />
              <View style={styles.settingsRowLabelWrap}>
                <Text style={styles.settingsRowLabel}>iCloudカレンダーを使用</Text>
                <Text style={styles.settingsRowDescription}>読み取り専用</Text>
              </View>
              <Switch accessibilityLabel="iCloudカレンダーを使用" value={status.enabled} disabled={busy} onValueChange={() => void run(async (current) => {
                const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", { method: "PATCH", body: JSON.stringify({ enabled: !status.enabled }) });
                if (version.current === current) { setStatus(next); setMessage(next.enabled ? "iCloudカレンダーを有効にしました。" : "iCloudカレンダーを無効にしました。"); }
              })} />
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="iCloudの接続を解除" disabled={busy}
              style={[styles.settingsRow, busy && styles.buttonDisabled]} onPress={() => void run(async (current) => {
                const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", { method: "DELETE" });
                if (version.current === current) { setStatus(next); setPassword(""); setTested(null); setMessage("Runnerから認証情報を削除しました。"); }
              })}>
              <Ionicons name="log-out-outline" size={22} color={theme.colors.controlDanger} />
              <Text style={styles.settingsDangerText}>接続を解除</Text>
            </TouchableOpacity>
          </> : null}
        </View>
        <Text style={styles.settingsFooterText}>MacのRunnerが起動していれば、アプリを閉じても利用できます。読み取り専用・iCloudの予定のみ（端末内・Google・Exchangeは対象外）。</Text>
      </View>

      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}><Text style={styles.settingsSectionTitle}>{configured ? "接続を変更" : "アカウント"}</Text></View>
        <View style={styles.settingsGroup}>
          <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
            <Ionicons name="person-outline" size={22} color={theme.colors.controlTextPrimary} />
            <View style={styles.settingsInputContent}>
              <Text style={styles.settingsRowLabel}>Apple Account</Text>
              <TextInput accessibilityLabel="Apple Account（メールアドレス）" value={account} onChangeText={(value) => edit("account", value)}
                placeholder="メールアドレス" placeholderTextColor={theme.colors.groupedTextMuted}
                autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" editable={!busy} style={styles.settingsInlineInput} />
            </View>
          </View>
          <View style={styles.settingsInputRow}>
            <Ionicons name="key-outline" size={22} color={theme.colors.controlTextPrimary} />
            <View style={styles.settingsInputContent}>
              <Text style={styles.settingsRowLabel}>アプリ用パスワード</Text>
              <View style={styles.settingsButtonRow}>
                <TextInput accessibilityLabel="アプリ用パスワード" value={password} onChangeText={(value) => edit("password", value)}
                  placeholder="xxxx-xxxx-xxxx-xxxx" placeholderTextColor={theme.colors.groupedTextMuted}
                  autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" secureTextEntry={!visible} editable={!busy}
                  style={[styles.settingsInlineInput, styles.settingsRowLabelWrap]} />
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={visible ? "パスワードを隠す" : "パスワードを表示"}
                  style={styles.settingsSelectCloseButton} onPress={() => setVisible(!visible)}>
                  <Ionicons name={visible ? "eye-off-outline" : "eye-outline"} size={22} color={theme.colors.controlAccent} />
                </TouchableOpacity>
              </View>
              <Text style={styles.settingsRowDescription}>{visible ? "入力を表示中。" : "入力を非表示。"}空白は除去し、ハイフンは保持します。</Text>
            </View>
          </View>
        </View>
        <Text style={styles.settingsFooterText}>通常のパスワードでは接続できません。アプリ用パスワードを使ってください。</Text>
        {tested ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="保存して有効にする" accessibilityState={{ disabled: busy }}
            disabled={busy} style={[styles.settingsPrimaryButton, busy && styles.buttonDisabled]} onPress={() => void run(async (current) => {
              if (!tested || Date.parse(tested.expiresAt) <= Date.now()) { setTested(null); throw new Error("接続テストをやり直してください。"); }
              const next = await requestICloudCalendar<ICloudCalendarStatus>(runnerUrl, runnerToken, "connection", {
                method: "PUT", body: JSON.stringify({ verificationToken: tested.verificationToken }),
              });
              if (version.current !== current) return;
              setStatus(next); setPassword(""); setTested(null); setMessage("iCloudカレンダーを有効にしました。");
            })}>
            <Ionicons name="checkmark-outline" size={18} color={theme.colors.textOnAccent} />
            <Text style={styles.settingsPrimaryButtonText}>{busy ? "処理中…" : "保存して有効にする"}</Text>
          </TouchableOpacity> : <TouchableOpacity accessibilityRole="button" accessibilityLabel="接続をテスト" accessibilityState={{ disabled: busy || !account.trim() || !password.trim() }}
          disabled={busy || !account.trim() || !password.trim()} style={[styles.settingsPrimaryButton, (busy || !account.trim() || !password.trim()) && styles.buttonDisabled]}
          onPress={() => void run(async (current) => {
            setTested(null);
            const result = await requestICloudCalendar<ICloudConnectionTest>(runnerUrl, runnerToken, "test", {
              method: "POST", body: JSON.stringify({ account, password }),
            });
            if (version.current !== current) return;
            setTested(result); setMessage(`接続テスト成功: カレンダー${result.calendarCount}件、今後7日間の予定${result.eventCount}件${result.truncated ? "以上（一部のみ）" : ""}。保存すると有効になります。`);
          })}>
          <Ionicons name="link-outline" size={18} color={theme.colors.textOnAccent} />
          <Text style={styles.settingsPrimaryButtonText}>{busy ? "処理中…" : "接続をテスト"}</Text>
        </TouchableOpacity>}
        {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
        {message ? <Text style={styles.settingsSuccessText}>{message}</Text> : null}
        <Text style={styles.settingsFooterText}>テスト後に保存すると有効になります。認証情報はRunnerで暗号化して保管し、この端末には保存しません。</Text>
      </View>

      <View style={styles.settingsSection}>
        <View style={styles.settingsGroup}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="アプリ用パスワードの発行方法" accessibilityState={{ expanded: helpOpen }}
            style={[styles.settingsRow, helpOpen && styles.settingsRowDivider]} onPress={() => setHelpOpen(!helpOpen)}>
            <Ionicons name="help-circle-outline" size={22} color={theme.colors.controlTextPrimary} />
            <View style={styles.settingsRowLabelWrap}><Text style={styles.settingsRowLabel}>アプリ用パスワードの発行方法</Text></View>
            <Ionicons name={helpOpen ? "chevron-up-outline" : "chevron-down-outline"} size={20} color={theme.colors.iconMuted} />
          </TouchableOpacity>
          {helpOpen ? <View style={styles.settingsInputRow}><View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowDescription}>普段のApple Accountを使います。開発者アカウントは不要です。</Text>
            <Text style={styles.settingsRowDescription}>2ファクタ認証を有効にし、account.apple.com → サインインとセキュリティ → アプリ用パスワード → 生成。</Text>
            <TouchableOpacity accessibilityRole="link" accessibilityLabel="Apple Accountでパスワードを発行" style={styles.settingsRow}
              onPress={() => void Linking.openURL("https://account.apple.com/").catch(() => setError("Apple Accountのページを開けませんでした。"))}>
              <Text style={styles.settingsActionText}>Apple Accountを開く</Text>
              <Ionicons name="open-outline" size={18} color={theme.colors.controlAccent} />
            </TouchableOpacity>
          </View></View> : null}
        </View>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
