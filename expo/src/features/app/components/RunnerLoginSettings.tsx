import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppShell } from "../contexts/AppShellContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { runnerLoginStylesByTheme } from "../styles/runnerLoginStyles";
import { setStringAsync } from "../clipboard";
import {
  isRunnerSessionToken, requestRunnerLogin, RunnerLoginError, runnerLoginErrorMessage,
  type RunnerChallenge, type RunnerDevice, type RunnerLoginResult, type RunnerSession,
} from "../utils/runnerLogin";

type Challenge = RunnerChallenge & { clientBinding: string; purpose: "login" | "reauth" | "recovery" };
type Recovery = { recoveryId: string; secret: string; uri: string; expiresAt: string };
type IconName = ComponentProps<typeof Ionicons>["name"];
const digits = (value: string, length: number) => value.normalize("NFKC").replace(/\D/g, "").slice(0, length);
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "不明" : date.toLocaleString("ja-JP", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
};

export function RunnerLoginSettings() {
  const { theme, themeId } = useVisualTheme();
  const styles = runnerLoginStylesByTheme[themeId];
  const { runnerUrl, runnerToken, saveRunnerToken } = useAppSettings();
  const { openCloudflareTunnelMonitorScreen } = useAppShell();
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [codeStep, setCodeStep] = useState<"mail" | "authenticator">("mail");
  const [devices, setDevices] = useState<RunnerDevice[]>([]);
  const [sessionExpiry, setSessionExpiry] = useState("");
  const [pendingDevice, setPendingDevice] = useState<RunnerDevice | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const current = useRef({ runnerUrl, runnerToken });
  current.current = { runnerUrl, runnerToken };
  const generation = useRef(0);
  const loggedIn = isRunnerSessionToken(runnerToken);
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = Boolean(challenge && Date.parse(challenge.expiresAt) <= now);

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);
  useEffect(() => {
    generation.current += 1;
    setChallenge(null); setRecovery(null); setEmailCode(""); setTotpCode("");
    setRecoveryCode(""); setDevices([]); setError(""); setMessage(""); setBusy(false);
    setCodeStep("mail"); setPendingDevice(null); setSessionExpiry(""); busyRef.current = false;
    if (!isRunnerSessionToken(runnerToken) || !runnerUrl) return;
    let active = true;
    void Promise.all([
      requestRunnerLogin<RunnerSession>(runnerUrl, "/auth/session", { token: runnerToken }),
      requestRunnerLogin<{ devices: RunnerDevice[] }>(runnerUrl, "/auth/devices", { token: runnerToken }),
    ]).then(([session, result]) => {
      if (!active) return;
      setEmail(session.ownerEmail); setSessionExpiry(session.expiresAt); setDevices(result.devices);
    }).catch((reason) => { if (active) setError(runnerLoginErrorMessage(reason)); });
    return () => { active = false; };
  }, [runnerUrl, runnerToken]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    const started = generation.current;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (reason) {
      if (started === generation.current) setError(reason instanceof RunnerLoginError && reason.code === "invalid_authentication" && recoveryMode
        ? recovery ? "新しく登録した認証アプリの6桁を確認してください。" : "最新メールの8桁と、保存した復旧コードを確認してください。"
        : runnerLoginErrorMessage(reason));
    }
    finally { if (started === generation.current) { busyRef.current = false; setBusy(false); } }
  }

  function cancelFlow() {
    generation.current += 1;
    setChallenge(null); setRecovery(null); setEmailCode(""); setTotpCode("");
    setRecoveryCode(""); setCodeStep("mail"); setError(""); setMessage(""); setPendingDevice(null);
  }

  async function start(purpose: Challenge["purpose"]) {
    const snapshot = { ...current.current };
    const started = generation.current;
    const clientBinding = challenge?.purpose === purpose
      ? challenge.clientBinding : Crypto.randomUUID() + Crypto.randomUUID();
    const result = await requestRunnerLogin<RunnerChallenge>(snapshot.runnerUrl, `/auth/${purpose}/start`, {
      token: purpose === "reauth" ? snapshot.runnerToken : "", body: { email: email.trim(), clientBinding },
    });
    if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
    setChallenge({ ...result, clientBinding, purpose }); setEmailCode(""); setTotpCode(""); setCodeStep("mail");
    setNow(Date.now()); setResendAt(Date.now() + 60000);
  }

  async function revoke(device: RunnerDevice) {
    const snapshot = { ...current.current };
    const started = generation.current;
    try {
      await requestRunnerLogin(snapshot.runnerUrl, `/auth/devices/${encodeURIComponent(device.id)}`, {
        token: snapshot.runnerToken, method: "DELETE",
      });
    } catch (reason) {
      if (started !== generation.current || current.current.runnerToken !== snapshot.runnerToken || current.current.runnerUrl !== snapshot.runnerUrl) return;
      if (reason instanceof RunnerLoginError && reason.code === "reauthentication_required") {
        setPendingDevice(device); await start("reauth"); return;
      }
      throw reason;
    }
    if (started !== generation.current || current.current.runnerToken !== snapshot.runnerToken || current.current.runnerUrl !== snapshot.runnerUrl) return;
    const result = await requestRunnerLogin<{ devices: RunnerDevice[] }>(snapshot.runnerUrl, "/auth/devices", { token: snapshot.runnerToken });
    if (started === generation.current && current.current.runnerToken === snapshot.runnerToken && current.current.runnerUrl === snapshot.runnerUrl) {
      setDevices(result.devices); setPendingDevice(null); setMessage("端末の接続を解除しました。");
    }
  }

  async function complete() {
    if (!challenge) return;
    const snapshot = { ...current.current };
    const started = generation.current;
    const body = { challengeId: challenge.challengeId, clientBinding: challenge.clientBinding,
      emailCode, totpCode, deviceName: Platform.OS === "macos" ? "Mac" : "iPhone", os: Platform.OS };
    if (challenge.purpose === "recovery") {
      const result = await requestRunnerLogin<Recovery>(snapshot.runnerUrl, "/auth/recovery/prepare", {
        body: { ...body, recoveryCode: recoveryCode.trim() },
      });
      if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
      setRecovery(result); setEmailCode(""); setRecoveryCode(""); setTotpCode(""); return;
    }
    const result = await requestRunnerLogin<RunnerLoginResult>(snapshot.runnerUrl, `/auth/${challenge.purpose}/complete`, {
      token: challenge.purpose === "reauth" ? snapshot.runnerToken : "", body,
    });
    if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
    if (challenge.purpose === "login") {
      if (!isRunnerSessionToken(result.token)) throw new RunnerLoginError("invalid_authentication_response", 0);
      try { await saveRunnerToken(result.token); }
      catch (reason) {
        await requestRunnerLogin(snapshot.runnerUrl, "/auth/logout", { token: result.token, body: {} }).catch(() => undefined);
        setChallenge(null); throw reason;
      }
    } else {
      setChallenge(null); setEmailCode(""); setTotpCode("");
      if (pendingDevice) await revoke(pendingDevice);
    }
  }

  async function logout() {
    const snapshot = { ...current.current };
    await saveRunnerToken("");
    try { await requestRunnerLogin(snapshot.runnerUrl, "/auth/logout", { token: snapshot.runnerToken, body: {} }); }
    catch (reason) {
      if (!(reason instanceof RunnerLoginError && reason.code === "authentication_required")) {
        Alert.alert("この端末からログアウトしました", "サーバー側の解除は未確認です。他の端末かMacから確認してください。");
      }
    }
  }

  function confirmDisconnect(device?: RunnerDevice) {
    const snapshot = { ...current.current };
    const started = generation.current;
    Alert.alert(device ? "端末の接続を解除しますか？" : "ログアウトしますか？",
      device ? `${device.name || "この端末"}では、再ログインが必要になります。` : "この端末では、再ログインが必要になります。", [
        { text: "キャンセル", style: "cancel" },
        { text: device ? "接続を解除" : "ログアウト", style: "destructive", onPress: () => {
          if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
          void run(() => !device || device.current ? logout() : revoke(device));
        } },
      ]);
  }

  async function finishRecovery() {
    if (!recovery || !challenge) return;
    const snapshot = { ...current.current };
    const started = generation.current;
    const result = await requestRunnerLogin<{ recoveryCodes: string[] }>(snapshot.runnerUrl, "/auth/recovery/complete", {
      body: { recoveryId: recovery.recoveryId, clientBinding: challenge.clientBinding, totpCode },
    });
    if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
    setRecoveryCodes(result.recoveryCodes); setRecovery(null); setChallenge(null); setRecoveryMode(false); setTotpCode("");
  }

  const input = (label: string, value: string, onChange: (value: string) => void, length?: number) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={[styles.input, length ? styles.codeInput : undefined]} value={value}
        onChangeText={length ? (text) => onChange(digits(text, length)) : onChange} editable={!busy}
        autoCapitalize="none" autoCorrect={false} placeholder={length ? `${length}桁のコード` : label === "メールアドレス" ? "you@example.com" : "復旧コードを貼り付け"}
        placeholderTextColor={theme.colors.textSubtle}
        textContentType={label === "メールアドレス" ? "emailAddress" : label === "メール確認コード" ? "oneTimeCode" : "none"}
        autoComplete={label === "メール確認コード" ? "one-time-code" : "off"}
        keyboardType={length ? "number-pad" : label === "メールアドレス" ? "email-address" : "default"}
        secureTextEntry={label === "復旧コード"} />
    </View>
  );
  const button = (label: string, action: () => void, icon: IconName, primary = false, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy || disabled}
      accessibilityState={{ disabled: busy || disabled, busy: primary && busy }} onPress={action}
      style={[primary ? styles.primary : styles.secondary, (busy || disabled) && styles.disabled]}>
      {primary && busy ? <ActivityIndicator color={theme.colors.textOnAccent} /> :
        <Ionicons name={icon} size={primary ? 18 : 16} color={primary ? theme.colors.textOnAccent : theme.colors.controlAccent} />}
      <Text style={primary ? styles.primaryText : styles.secondaryText}>{primary && busy ? label === "確認メールを送る" ? "送信中…" : "確認中…" : label}</Text>
    </Pressable>
  );
  const notice = <>
    {error ? <View style={styles.notice}><Ionicons name="alert-circle-outline" size={18} color={theme.tones.danger.foreground} />
      <Text accessibilityRole="alert" style={[styles.error, styles.noticeText]}>{error}</Text></View> : null}
    {message ? <Text style={styles.success}>{message}</Text> : null}
  </>;

  if (loggedIn && !challenge) return <View style={styles.section}>
    <Text style={styles.sectionTitle}>セキュリティ</Text>
    <View style={styles.group}>
      <View style={styles.summary}>
        <View style={styles.summaryIcon}><Ionicons name="shield-checkmark-outline" size={23} color={theme.colors.controlAccent} /></View>
        <View style={styles.rowContent}><Text style={styles.rowTitle}>2段階認証で保護されています</Text>
          <Text style={styles.rowSubtitle}>{email || "ログイン情報を確認中…"}</Text></View>
      </View>
      {devices.map((device) => <View key={device.id} style={styles.device}>
        <Ionicons name={device.os === "macos" ? "laptop-outline" : "phone-portrait-outline"} size={23} color={theme.colors.groupedTextMuted} />
        <View style={styles.rowContent}><View style={styles.deviceHeading}>
          <Text style={styles.rowTitle}>{device.name || "名前なしの端末"}</Text>
          {device.current ? <View style={styles.badge}><Text style={styles.badgeText}>この端末</Text></View> : null}
        </View><Text style={styles.rowSubtitle}>最終利用 {dateLabel(device.lastUsedAt)}</Text>
          {!device.current ? <Text style={styles.rowSubtitle}>登録 {dateLabel(device.createdAt)}</Text> : null}
          {device.notificationStatus === "failed" ? <Text style={styles.rowSubtitle}>ログイン通知を送れませんでした</Text> : null}
        </View>
        {!device.current ? <Pressable accessibilityRole="button" accessibilityLabel={`${device.name || "端末"}の接続を解除`}
          disabled={busy} onPress={() => confirmDisconnect(device)} style={styles.deviceAction}>
          <Text style={styles.deviceActionText}>解除</Text>
        </Pressable> : null}
      </View>)}
      <Pressable accessibilityRole="button" accessibilityLabel="この端末からログアウト" disabled={busy}
        onPress={() => confirmDisconnect()} style={styles.groupAction}>
        <Ionicons name="log-out-outline" size={20} color={theme.colors.controlDanger} />
        <Text style={styles.dangerText}>ログアウト</Text>
      </Pressable>
    </View>
    {notice}
    <Text style={styles.sectionFooter}>{sessionExpiry ? `${dateLabel(sessionExpiry)}までログインを保持。` : "最長30日間ログインを保持。"}7日間使わないと再ログインが必要です。</Text>
  </View>;

  const step = !challenge ? 0 : codeStep === "mail" ? 1 : 2;
  const title = recoveryCodes.length ? "復旧コードを保存" : recovery ? "認証アプリを再登録" : !challenge
    ? recoveryMode ? "ログインを復旧" : "Bittyにログイン" : codeStep === "mail" ? "メールを確認" : recoveryMode ? "復旧コードを入力" : "認証アプリを確認";
  const description = recoveryCodes.length ? "一度だけ表示します。安全な場所に保管してください。" : recovery
    ? "Google Authenticatorなどに、下の設定キーを登録してください。" : !challenge
      ? recoveryMode ? "メールと復旧コードで、認証アプリを再登録します。" : "いつもの会話へ、安全につながる。"
      : codeStep === "mail" ? email : recoveryMode ? "初期設定で保存したコードを使います。" : "最後に登録した「Bitty」の6桁を使います。";
  return <View style={styles.section}>
    {loggedIn ? <Text style={styles.sectionTitle}>{pendingDevice ? `「${pendingDevice.name || "端末"}」の接続を解除` : "本人確認"}</Text> : null}
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconTile}><Ionicons name={recoveryMode || recovery || recoveryCodes.length ? "key-outline" : step === 1 ? "mail-outline" : step === 2 ? "shield-checkmark-outline" : "lock-closed-outline"} size={24} color={theme.colors.controlAccent} /></View>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.description}>{description}</Text>
      </View>
      {!recoveryCodes.length && !recovery ? <View accessible accessibilityLabel={`手順${step + 1}/3`} style={styles.progress}>
        {["メール", "メール確認", recoveryMode ? "復旧コード" : "認証アプリ"].map((label, index) => <View key={label} style={styles.progressItem}>
          <View style={[styles.progressLine, index <= step && styles.progressLineActive]} />
          <Text style={[styles.progressLabel, index === step && styles.progressLabelActive]}>{label}</Text>
        </View>)}
      </View> : null}
      {recoveryCodes.length ? <>
        <View style={styles.recoveryCodes}>{recoveryCodes.map((code) => <Text key={code} selectable style={styles.recoveryCode}>{code}</Text>)}</View>
        {button("復旧コードをコピー", () => void run(async () => { await setStringAsync(recoveryCodes.join("\n")); setMessage("復旧コードをコピーしました。"); }), "copy-outline")}
        {button("保存してログインへ", () => setRecoveryCodes([]), "checkmark-outline", true)}
      </> : recovery ? <View style={styles.fields}>
        <Text selectable style={[styles.recoveryCodes, styles.recoveryCode]}>{recovery.secret}</Text>
        {button("設定キーをコピー", () => void run(async () => { await setStringAsync(recovery.secret); setMessage("設定キーをコピーしました。"); }), "copy-outline")}
        {input("新しい認証アプリのコード", totpCode, setTotpCode, 6)}
        {button("登録を完了", () => void run(finishRecovery), "checkmark-outline", true, totpCode.length !== 6)}
      </View> : !challenge ? <View style={styles.fields}>
        {input("メールアドレス", email, setEmail)}
        {button("確認メールを送る", () => void run(() => start(recoveryMode ? "recovery" : "login")), "arrow-forward-outline", true, !email.trim() || !runnerUrl)}
      </View> : <View style={styles.fields}>
        {codeStep === "mail" ? <>
          <Text style={styles.description}>アプリから送った最新メールの8桁を入力してください。</Text>
          {input("メール確認コード", emailCode, setEmailCode, 8)}
          {button("次へ", () => { setCodeStep("authenticator"); setError(""); }, "arrow-forward-outline", true, emailCode.length !== 8 || expired)}
        </> : <>
          {!recoveryMode ? <Text style={styles.description}>数字が切り替わってから入力してください。</Text> : null}
          {recoveryMode ? input("復旧コード", recoveryCode, setRecoveryCode) : input("認証アプリのコード", totpCode, setTotpCode, 6)}
          {button(challenge.purpose === "reauth" ? "確認して接続を解除" : recoveryMode ? "認証アプリを再登録" : "ログイン",
            () => void run(complete), "checkmark-outline", true, (recoveryMode ? !recoveryCode.trim() : totpCode.length !== 6) || expired)}
        </>}
        {expired ? <Text style={styles.error}>メールの期限が切れました。再送してください。</Text> : null}
        <View style={styles.actions}>
          {button(resendSeconds ? `再送まで${resendSeconds}秒` : "メールを再送", () => void run(() => start(challenge.purpose)), "refresh-outline", false, resendSeconds > 0)}
          {button(codeStep === "authenticator" ? "メールコードを見直す" : loggedIn ? "キャンセル" : "メールアドレスを変更",
            () => { if (codeStep === "authenticator") { setCodeStep("mail"); setTotpCode(""); setError(""); } else cancelFlow(); }, "arrow-back-outline")}
        </View>
      </View>}
      {notice}
      {!loggedIn && !challenge && !recovery && !recoveryCodes.length ? <>
        <View style={styles.divider} />
        <View style={styles.actions}>
          {button(recoveryMode ? "ログインに戻る" : "認証アプリを使えない場合", () => { setRecoveryMode(!recoveryMode); setError(""); }, "key-outline")}
          {button("接続先を設定", openCloudflareTunnelMonitorScreen, "qr-code-outline")}
        </View>
      </> : null}
    </View>
    {!loggedIn && !challenge && !recovery && !recoveryCodes.length ? <View style={styles.footer}><Ionicons name="shield-checkmark-outline" size={15} color={theme.colors.groupedTextMuted} />
      <Text style={styles.footerNote}>初回はMacで初期設定を済ませ、接続QRを読み取ってください。</Text></View> : null}
  </View>;
}
