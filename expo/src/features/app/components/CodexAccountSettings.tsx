import { useEffect, useState } from "react";
import { Alert, Linking, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useChatDiagnostics } from "../contexts/ChatDiagnosticsContext";
import { styles } from "../styles";
import { formatCodexAuthRateLimits } from "../utils/codexAuthRateLimits";
import type { CodexAuthRegistration } from "../hooks/useCodexStatusAuthController";

export type RegistrationState = CodexAuthRegistration & {
  status: string;
  reauth?: boolean;
  reauthWasActive?: boolean;
};
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

export function mergeCodexAuthRegistration(previous: RegistrationState, next: Partial<CodexAuthRegistration>): RegistrationState {
  return { ...previous, ...next, authId: next.authId || previous.authId, registrationId: previous.registrationId };
}

export function CodexAccountSettings() {
  const diagnostics = useChatDiagnostics();
  const {
    cancelCodexAuthRegistration,
    deleteCodexAuthProfile,
    getCodexAuthRegistration,
    loadCodexAuthProfiles,
    reauthCodexAuthProfile,
    startCodexAuthRegistration,
    switchCodexAuthProfile,
  } = diagnostics;
  const [authId, setAuthId] = useState("");
  const [registration, setRegistration] = useState<RegistrationState | null>(null);
  const currentAuthId = diagnostics.codexAuthProfiles.find((profile) => profile.isCurrent)?.authId || "";
  const registrationId = registration?.registrationId;

  useEffect(() => {
    loadCodexAuthProfiles();
  }, [loadCodexAuthProfiles]);

  useEffect(() => {
    if (!registrationId || !registration || TERMINAL.has(registration.status)) return;
    let cancelled = false;
    let latest = registration;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await getCodexAuthRegistration(registrationId);
        if (cancelled) return;
        const merged = mergeCodexAuthRegistration(latest, next);
        latest = merged;
        setRegistration(merged);
        if (merged.status === "completed") {
          await loadCodexAuthProfiles();
          if (cancelled) return;
          if (merged.authId && (!merged.reauth || merged.reauthWasActive)) {
            await switchCodexAuthProfile(merged.authId);
          }
          return;
        }
      } catch { /* keep polling through transient errors */ }
      if (!cancelled && !TERMINAL.has(latest.status)) {
        timer = setTimeout(() => void poll(), 2000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [getCodexAuthRegistration, loadCodexAuthProfiles, registrationId, switchCodexAuthProfile]);

  const begin = async (requestedAuthId: string, reauth = false) => {
    try {
      const result = reauth ? await reauthCodexAuthProfile(requestedAuthId) : await startCodexAuthRegistration(requestedAuthId);
      setRegistration({
        ...result,
        authId: requestedAuthId,
        reauth,
        reauthWasActive: reauth && requestedAuthId === currentAuthId,
        status: result.status || "pending",
      });
    } catch (error) { Alert.alert("登録失敗", error instanceof Error ? error.message : String(error)); }
  };
  const cancel = async () => { if (!registration) return; try { await cancelCodexAuthRegistration(registration.registrationId); } finally { setRegistration(null); } };
  const openUrl = async (url?: string) => { if (url && await Linking.canOpenURL(url)) await Linking.openURL(url); };

  return (
    <View style={styles.settingsSection}>
      <Text style={styles.settingsSectionTitle}>Codexアカウント</Text>
      {diagnostics.codexAuthProfiles.map((profile) => (
        <View key={profile.authId} style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>{profile.displayName || profile.authId}</Text>
            <Text>{profile.planType || "プラン不明"}・{profile.status || "状態不明"}</Text>
            <Text>{formatCodexAuthRateLimits(profile) || "利用制限未取得"}</Text>
          </View>
          <TouchableOpacity onPress={() => void begin(profile.authId, true)}><Text style={styles.settingsActionText}>再認証</Text></TouchableOpacity>
          <TouchableOpacity disabled={profile.authId === currentAuthId} onPress={() => Alert.alert("削除確認", `${profile.authId}を削除しますか？`, [{ text: "キャンセル" }, { text: "削除", onPress: () => void deleteCodexAuthProfile(profile.authId).then(() => loadCodexAuthProfiles()).catch((error) => Alert.alert("削除失敗", String(error))) }])}><Text style={[styles.settingsActionText, profile.authId === currentAuthId && { opacity: 0.4 }]}>削除</Text></TouchableOpacity>
        </View>
      ))}
      <TextInput value={authId} onChangeText={setAuthId} placeholder="アカウント名" style={{ borderWidth: 1, borderColor: "#999", padding: 8, marginVertical: 8 }} autoCapitalize="none" />
      <TouchableOpacity disabled={!authId.trim()} onPress={() => void begin(authId.trim())}><Text style={styles.settingsActionText}>アカウントを追加</Text></TouchableOpacity>
      {registration ? (
        <View>
          <Text>コード: {registration.userCode || "-"}</Text>
          <Text>{registration.status}{registration.errorCode ? ` (${registration.errorCode})` : ""}</Text>
          <TouchableOpacity disabled={!registration.verificationUrl} onPress={() => void openUrl(registration.verificationUrl)}>
            <Text style={styles.settingsActionText}>認証ページを開く</Text>
          </TouchableOpacity>
          {!TERMINAL.has(registration.status) ? <TouchableOpacity onPress={() => void cancel()}><Text style={styles.settingsActionText}>キャンセル</Text></TouchableOpacity> : null}
        </View>
      ) : null}
    </View>
  );
}
