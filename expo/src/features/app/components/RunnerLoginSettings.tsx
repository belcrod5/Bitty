import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppShell } from "../contexts/AppShellContext";
import { useAppStyles } from "../styles";
import {
  isRunnerSessionToken, requestRunnerLogin, RunnerLoginError, runnerLoginErrorMessage,
  type RunnerChallenge, type RunnerDevice, type RunnerLoginResult, type RunnerSession,
} from "../utils/runnerLogin";

type Challenge = RunnerChallenge & { clientBinding: string; purpose: "login" | "reauth" | "recovery" };
type Recovery = { recoveryId: string; secret: string; uri: string; expiresAt: string };

export function RunnerLoginSettings() {
  const styles = useAppStyles();
  const { runnerUrl, runnerToken, saveRunnerToken } = useAppSettings();
  const { openCloudflareTunnelMonitorScreen } = useAppShell();
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [deviceName, setDeviceName] = useState(Platform.OS === "macos" ? "Mac" : "iPhone");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [devices, setDevices] = useState<RunnerDevice[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const current = useRef({ runnerUrl, runnerToken });
  current.current = { runnerUrl, runnerToken };
  const generation = useRef(0);
  const loggedIn = isRunnerSessionToken(runnerToken);
  useEffect(() => () => { generation.current += 1; }, []);

  useEffect(() => {
    generation.current += 1;
    setChallenge(null); setRecovery(null); setEmailCode(""); setTotpCode("");
    setRecoveryCode(""); setDevices([]); setError(""); setMessage(""); setBusy(false);
    if (!isRunnerSessionToken(runnerToken) || !runnerUrl) return;
    let active = true;
    void Promise.all([
      requestRunnerLogin<RunnerSession>(runnerUrl, "/auth/session", { token: runnerToken }),
      requestRunnerLogin<{ devices: RunnerDevice[] }>(runnerUrl, "/auth/devices", { token: runnerToken }),
    ]).then(([session, result]) => {
      if (!active) return;
      setEmail(session.ownerEmail); setDevices(result.devices);
    }).catch((reason) => { if (active) setError(runnerLoginErrorMessage(reason)); });
    return () => { active = false; };
  }, [runnerUrl, runnerToken]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    const started = generation.current;
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (reason) { if (started === generation.current) setError(runnerLoginErrorMessage(reason)); }
    finally { if (started === generation.current) setBusy(false); }
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
    setChallenge({ ...result, clientBinding, purpose }); setEmailCode(""); setTotpCode("");
    setMessage("メールの確認コードを入力してください。有効期限は10分です。");
  }

  async function complete() {
    if (!challenge) return;
    const snapshot = { ...current.current };
    const started = generation.current;
    const body = { challengeId: challenge.challengeId, clientBinding: challenge.clientBinding,
      emailCode: emailCode.trim(), totpCode: totpCode.trim(), deviceName: deviceName.trim(), os: Platform.OS };
    if (challenge.purpose === "recovery") {
      const result = await requestRunnerLogin<Recovery>(snapshot.runnerUrl, "/auth/recovery/prepare", {
        body: { ...body, recoveryCode: recoveryCode.trim() },
      });
      if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
      setRecovery(result); setEmailCode(""); setRecoveryCode(""); setTotpCode("");
      return;
    }
    const result = await requestRunnerLogin<RunnerLoginResult>(snapshot.runnerUrl, `/auth/${challenge.purpose}/complete`, {
      token: challenge.purpose === "reauth" ? snapshot.runnerToken : "", body,
    });
    if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
    if (challenge.purpose === "login") {
      if (!isRunnerSessionToken(result.token)) throw new RunnerLoginError("invalid_authentication_response", 0);
      try { await saveRunnerToken(result.token); }
      catch (reason) {
        // A credential that could not be persisted must not leave an unmanageable
        // live session behind. No old shared-token fallback is permitted.
        await requestRunnerLogin(snapshot.runnerUrl, "/auth/logout", { token: result.token, body: {} }).catch(() => undefined);
        setChallenge(null);
        throw reason;
      }
    } else {
      setChallenge(null); setEmailCode(""); setTotpCode("");
      setMessage("本人確認が完了しました。対象端末の失効をもう一度押してください。");
    }
  }

  async function revoke(device: RunnerDevice) {
    if (device.current) return logout();
    const snapshot = { ...current.current };
    const started = generation.current;
    await requestRunnerLogin(snapshot.runnerUrl, `/auth/devices/${encodeURIComponent(device.id)}`, {
      token: snapshot.runnerToken, method: "DELETE",
    });
    if (started !== generation.current || current.current.runnerToken !== snapshot.runnerToken || current.current.runnerUrl !== snapshot.runnerUrl) return;
    if (device.current) await saveRunnerToken("");
    else {
      const result = await requestRunnerLogin<{ devices: RunnerDevice[] }>(snapshot.runnerUrl, "/auth/devices", {
        token: snapshot.runnerToken,
      });
      if (current.current.runnerToken === snapshot.runnerToken) setDevices(result.devices);
    }
  }

  async function logout() {
    const snapshot = { ...current.current };
    // Local access ends even offline. Remote revocation is a separate outcome,
    // and a failed request must never be presented as confirmed revocation.
    await saveRunnerToken("");
    try {
      await requestRunnerLogin(snapshot.runnerUrl, "/auth/logout", { token: snapshot.runnerToken, body: {} });
    } catch (reason) {
      if (!(reason instanceof RunnerLoginError && reason.code === "authentication_required")) {
        Alert.alert("この端末からログアウトしました", "通信できず、サーバーでの失効は確認できませんでした。他の登録端末またはMacから、この端末を失効してください。");
      }
    }
  }

  async function finishRecovery() {
    if (!recovery || !challenge) return;
    const snapshot = { ...current.current };
    const started = generation.current;
    const result = await requestRunnerLogin<{ recoveryCodes: string[] }>(runnerUrl, "/auth/recovery/complete", {
      body: { recoveryId: recovery.recoveryId, clientBinding: challenge.clientBinding, totpCode: totpCode.trim() },
    });
    if (started !== generation.current || current.current.runnerUrl !== snapshot.runnerUrl || current.current.runnerToken !== snapshot.runnerToken) return;
    setRecoveryCodes(result.recoveryCodes); setRecovery(null); setChallenge(null); setRecoveryMode(false);
    setTotpCode(""); setMessage("復旧が完了し、すべての端末が失効しました。新しいコードを保管して再ログインしてください。");
  }

  const input = (label: string, value: string, onChangeText: (value: string) => void, secret = false) => (
    <View style={styles.settingsInputContent}>
      <Text style={styles.settingsRowLabel}>{label}</Text>
      <TextInput accessibilityLabel={label} style={styles.settingsInlineInput} value={value}
        onChangeText={onChangeText} editable={!busy} autoCapitalize="none" autoCorrect={false}
        secureTextEntry={secret} textContentType={label === "メールアドレス" ? "emailAddress" : "none"}
        keyboardType={label === "メールアドレス" ? "email-address" : "default"} />
    </View>
  );
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={action} disabled={busy || disabled}
      style={[styles.settingsPrimaryButton, (busy || disabled) && styles.buttonDisabled]}>
      <Text style={styles.settingsPrimaryButtonText}>{label}</Text>
    </Pressable>
  );

  return <View style={styles.settingsSection}>
    <View style={styles.settingsSectionHeader}><Text style={styles.settingsSectionTitle}>本人ログインと端末</Text></View>
    <View style={styles.settingsGroup}>
      {!loggedIn ? <>
        <Text style={styles.hint}>初回はMacの接続設定QRを読み込み、メールとGoogle Authenticator等のコードでログインしてください。</Text>
        {button("接続設定QRを読み込む", openCloudflareTunnelMonitorScreen)}
        {recoveryCodes.length ? <View>
          <Text style={styles.settingsRowLabel}>新しい復旧コード（一度だけ表示）</Text>
          {recoveryCodes.map((code) => <Text key={code} selectable style={styles.hint}>{code}</Text>)}
          {button("復旧コードを保管しました", () => setRecoveryCodes([]))}
        </View> : null}
        {!recovery ? <>
          {input("メールアドレス", email, setEmail)}
          {!challenge ? <>
            {button(recoveryMode ? "復旧用メールを送る" : "ログイン用メールを送る",
              () => void run(() => start(recoveryMode ? "recovery" : "login")), !email.trim() || !runnerUrl)}
            {button(recoveryMode ? "ログインに戻る" : "Authenticatorを紛失した場合", () => {
              setRecoveryMode(!recoveryMode); setError(""); setRecoveryCodes([]);
            })}
          </> : <>
            {input("メール確認コード", emailCode, setEmailCode, true)}
            {recoveryMode ? input("復旧コード", recoveryCode, setRecoveryCode, true) : <>
              {input("Authenticatorコード", totpCode, setTotpCode, true)}
              {input("この端末の名前", deviceName, setDeviceName)}
            </>}
            {button(recoveryMode ? "新しいAuthenticatorを登録する" : "ログイン", () => void run(complete),
              !emailCode.trim() || !(recoveryMode ? recoveryCode.trim() : totpCode.trim()))}
            {button("コードを再送する", () => void run(() => start(challenge.purpose)))}
            {button("入力をやり直す", () => { setChallenge(null); setEmailCode(""); setTotpCode(""); setRecoveryCode(""); })}
          </>}
        </> : <>
          <Text style={styles.hint}>Authenticatorの手動登録に次の設定キーを入力し、新しいコードで確認してください。</Text>
          <Text selectable style={styles.hint}>{recovery.secret}</Text>
          {input("新しいAuthenticatorコード", totpCode, setTotpCode, true)}
          {button("復旧を完了する", () => void run(finishRecovery), !totpCode.trim())}
        </>}
      </> : <>
        <Text style={styles.hint}>{email ? `${email} でログイン中` : "この端末はログイン済みです。"}</Text>
        <Text style={styles.hint}>最長30日・未使用7日で再ログインが必要です。他の端末の失効には本人確認が必要です。</Text>
        {devices.map((device) => <View key={device.id} style={styles.settingsInputRow}>
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>{device.name || "名前なし"}{device.current ? "（この端末）" : ""}</Text>
            <Text style={styles.hint}>{device.os || "OS不明"} ・登録 {device.createdAt} ・最終利用 {device.lastUsedAt}</Text>
            {device.notificationStatus === "failed" ? <Text style={styles.settingsErrorText}>ログイン通知メールを送信できませんでした。</Text> : null}
            {button(`${device.name || "端末"}を失効する`, () => void run(() => revoke(device)))}
          </View>
        </View>)}
        {challenge?.purpose === "reauth" ? <>
          {input("メール確認コード", emailCode, setEmailCode, true)}
          {input("Authenticatorコード", totpCode, setTotpCode, true)}
          {button("本人確認を完了する", () => void run(complete), !emailCode.trim() || !totpCode.trim())}
        </> : button("他の端末を管理するため本人確認", () => void run(() => start("reauth")), !email)}
        {button("この端末からログアウト", () => void run(logout))}
      </>}
      {busy ? <Text style={styles.hint}>処理中…</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.settingsErrorText}>{error}</Text> : null}
      {message ? <Text style={styles.settingsSuccessText}>{message}</Text> : null}
    </View>
  </View>;
}
