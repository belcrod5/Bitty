import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";
import { useChatDiagnostics } from "../contexts/ChatDiagnosticsContext";
import { styles } from "../styles";
import { formatCodexAuthRateLimits } from "../utils/codexAuthRateLimits";
import type { CodexAuthRegistration } from "../hooks/useCodexStatusAuthController";

export type RegistrationState = CodexAuthRegistration & {
  status: string;
  reauth?: boolean;
  reauthWasActive?: boolean;
};
const TERMINAL = new Set(["completed", "authenticated", "failed", "cancelled", "expired"]);

export function mergeCodexAuthRegistration(previous: RegistrationState, next: Partial<CodexAuthRegistration>): RegistrationState {
  return {
    ...previous,
    ...next,
    authId: next.authId || previous.authId,
    registrationId: previous.registrationId,
  };
}

export function CodexAccountSettings() {
  const diagnostics = useChatDiagnostics();
  const {
    cancelCodexAuthRegistration,
    completeCodexAuthRegistration,
    deleteCodexAuthProfile,
    getCodexAuthRegistration,
    loadCodexAuthProfiles,
    reauthCodexAuthProfile,
    startCodexAuthRegistration,
    switchCodexAuthProfile,
  } = diagnostics;
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saveError, setSaveError] = useState("");
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
        if (merged.status === "completed" && merged.reauth) {
          await loadCodexAuthProfiles();
          if (merged.reauthWasActive) await switchCodexAuthProfile(merged.authId);
          setRegistration(null);
        }
      } catch {
        /* keep polling through transient errors */
      }
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
    if (starting || registration) return;
    setDisplayName("");
    setSaveError("");
    setSaving(false);
    setStarting(true);
    try {
      const result = reauth ? await reauthCodexAuthProfile(requestedAuthId) : await startCodexAuthRegistration();
      setRegistration({
        ...result,
        authId: result.authId || requestedAuthId,
        reauth,
        reauthWasActive: reauth && requestedAuthId === currentAuthId,
        status: result.status || "pending",
      });
    } catch (error) {
      Alert.alert("登録失敗", error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };
  const save = async () => {
    if (!registration || saving || !displayName.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await completeCodexAuthRegistration(registration.registrationId, displayName.trim());
      if (!(await switchCodexAuthProfile(result.authId))) await loadCodexAuthProfiles();
      setRegistration(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const cancel = async () => {
    if (!registration) return;
    try {
      await cancelCodexAuthRegistration(registration.registrationId);
    } finally {
      setRegistration(null);
    }
  };
  const openUrl = async (url?: string) => {
    if (url && (await Linking.canOpenURL(url))) await Linking.openURL(url);
  };
  const registrationPending = registration ? !TERMINAL.has(registration.status) : false;

  return (
    <View style={styles.settingsSection}>
      <View style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionTitle}>Codexアカウント</Text>
      </View>

      <View style={styles.settingsGroup}>
        {diagnostics.codexAuthProfiles.length === 0 ? (
          <View style={styles.settingsRow}>
            <Ionicons name="person-circle-outline" size={22} color="#111827" />
            <View style={styles.settingsRowLabelWrap}>
              <Text style={styles.settingsRowLabel}>登録済みアカウントなし</Text>
              <Text style={styles.settingsRowDescription}>Codex標準の認証を使用します。</Text>
            </View>
          </View>
        ) : (
          diagnostics.codexAuthProfiles.map((profile, index) => {
            const label = profile.displayName || profile.authId;
            const isCurrent = profile.authId === currentAuthId;
            return (
              <View key={profile.authId} style={[styles.settingsInputRow, index < diagnostics.codexAuthProfiles.length - 1 && styles.settingsRowDivider]}>
                <Ionicons name={isCurrent ? "checkmark-circle" : "person-circle-outline"} size={22} color={isCurrent ? "#0a84ff" : "#111827"} />
                <View style={styles.settingsInputContent}>
                  <Text style={styles.settingsRowLabel}>{label}</Text>
                  <Text style={styles.settingsRowDescription}>
                    {profile.planType || "プラン不明"}・{profile.status || "状態不明"}
                    {isCurrent ? "・使用中" : ""}
                  </Text>
                  <Text style={styles.settingsRowDescription}>{formatCodexAuthRateLimits(profile) || "利用制限未取得"}</Text>
                  <View style={styles.settingsButtonRow}>
                    <TouchableOpacity onPress={() => void begin(profile.authId, true)} accessibilityRole="button" accessibilityLabel={`${label}を再認証`}>
                      <Text style={styles.settingsActionText}>再認証</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      disabled={isCurrent}
                      onPress={() =>
                        Alert.alert("削除確認", `${profile.authId}を削除しますか？`, [
                          { text: "キャンセル" },
                          {
                            text: "削除",
                            style: "destructive",
                            onPress: () =>
                              void deleteCodexAuthProfile(profile.authId)
                                .then(() => loadCodexAuthProfiles())
                                .catch((error) => Alert.alert("削除失敗", String(error))),
                          },
                        ])
                      }
                      style={isCurrent ? styles.buttonDisabled : undefined}
                      accessibilityRole="button"
                      accessibilityLabel={`${label}を削除`}
                      accessibilityState={{ disabled: isCurrent }}
                    >
                      <Text style={styles.settingsDangerText}>削除</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={styles.settingsGroup}>
        <View style={styles.settingsInputRow}>
          <Ionicons name="person-add-outline" size={22} color="#111827" />
          <View style={styles.settingsInputContent}>
            <Text style={styles.settingsRowLabel}>アカウントを追加</Text>
            <Text style={styles.settingsRowDescription}>認証後に保存名を設定します。</Text>
            <View style={styles.settingsButtonRow}>
              <Pressable
                style={[styles.settingsPrimaryButton, starting && styles.buttonDisabled]}
                onPress={() => void begin("")}
                accessibilityRole="button"
                accessibilityLabel="Codexアカウントを追加"
                disabled={starting || !!registration}
                accessibilityState={{ disabled: starting || !!registration }}
              >
                <Ionicons name="add-circle-outline" size={18} color="#ffffff" />
                <Text style={styles.settingsPrimaryButtonText}>追加して認証</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {registration ? (
        <AppModal visible transparent animationType="slide" onRequestClose={() => void cancel()}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} automaticOffset={Platform.OS === "ios"} style={styles.settingsSelectBackdrop}>
            <View style={styles.settingsSelectCard} accessibilityViewIsModal>
              <View style={styles.settingsSelectHeader}>
                <Text style={styles.settingsSelectTitle}>Codexアカウント認証</Text>
                <TouchableOpacity onPress={() => void cancel()} accessibilityRole="button" accessibilityLabel="Codexアカウント認証を閉じる" style={styles.settingsSelectCloseButton}>
                  <Ionicons name="close" size={21} color="#4b5563" />
                </TouchableOpacity>
              </View>
              <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
                <View style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <Ionicons name="key-outline" size={22} color="#111827" />
                  <Text style={[styles.settingsRowLabel, styles.settingsRowLabelWrap]}>認証コード</Text>
                  <Text style={styles.settingsRowValue} selectable>
                    {registration.userCode || "-"}
                  </Text>
                </View>
                <View style={[styles.settingsRow, styles.settingsRowDivider]}>
                  <Ionicons name="information-circle-outline" size={22} color="#111827" />
                  <Text style={[styles.settingsRowLabel, styles.settingsRowLabelWrap]}>認証状態</Text>
                  <Text style={registration.errorCode ? styles.settingsErrorText : styles.settingsRowValue} accessibilityRole={registration.errorCode ? "alert" : undefined}>
                    {registration.status}
                    {registration.errorCode ? ` (${registration.errorCode})` : ""}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.settingsRow, registrationPending && styles.settingsRowDivider, !registration.verificationUrl && styles.buttonDisabled]}
                  disabled={!registration.verificationUrl}
                  onPress={() => void openUrl(registration.verificationUrl)}
                  accessibilityRole="button"
                  accessibilityLabel="Codex認証ページを開く"
                  accessibilityState={{
                    disabled: !registration.verificationUrl,
                  }}
                >
                  <Ionicons name="open-outline" size={22} color="#0a84ff" />
                  <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>認証ページを開く</Text>
                  <Ionicons name="chevron-forward" size={18} color="#c7c7cc" />
                </TouchableOpacity>
                {registration.status === "authenticated" && !registration.reauth ? (
                  <View style={[styles.settingsInputRow, styles.settingsRowDivider]}>
                    <Ionicons name="create-outline" size={22} color="#111827" />
                    <View style={styles.settingsInputContent}>
                      <Text style={styles.settingsRowLabel}>保存名</Text>
                      <Text style={styles.settingsRowDescription}>このアカウントを識別する名前を入力してください。</Text>
                      <TextInput value={displayName} onChangeText={setDisplayName} placeholder="例: 仕事用" style={styles.settingsInlineInput} />
                      {saveError ? <Text style={styles.settingsErrorText}>{saveError}</Text> : null}
                      <View style={styles.settingsButtonRow}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Codexアカウントを保存"
                          disabled={saving || !displayName.trim()}
                          style={[styles.settingsPrimaryButton, (saving || !displayName.trim()) && styles.buttonDisabled]}
                          onPress={() => void save()}
                        >
                          <Text style={styles.settingsPrimaryButtonText}>{saving ? "保存中…" : "保存"}</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                ) : null}
                {registrationPending || registration.status === "authenticated" ? (
                  <TouchableOpacity style={styles.settingsRow} onPress={() => void cancel()} accessibilityRole="button" accessibilityLabel="Codexアカウントの認証をキャンセル">
                    <Ionicons name="close-circle-outline" size={22} color="#ff3b30" />
                    <Text style={[styles.settingsDangerText, styles.settingsRowLabelWrap]}>{registration.status === "authenticated" ? "保存をやめる" : "認証をキャンセル"}</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.settingsRow} onPress={() => setRegistration(null)} accessibilityRole="button" accessibilityLabel="閉じる">
                    <Ionicons name="close-outline" size={22} color="#111827" />
                    <Text style={[styles.settingsActionText, styles.settingsRowLabelWrap]}>閉じる</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </AppModal>
      ) : null}
      <Text style={styles.settingsFooterText}>登録したアカウントはチャット画面のステータスメニューから切り替えられます。</Text>
    </View>
  );
}
