import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { setStringAsync } from "../clipboard";
import { ConnectionSettings } from "../components/ConnectionSettings";
import { SpeechSettings } from "../components/SpeechSettings";
import { CodexAccountSettings } from "../components/CodexAccountSettings";
import { GoogleCloudSettings } from "../components/GoogleCloudSettings";
import { VoiceConversationSettings } from "../components/VoiceConversationSettings";
import { useAppShell } from "../contexts/AppShellContext";
import { BUILD_STAMP } from "../buildStamp";
import { useAppStyles } from "../styles";
import { KeyboardAvoidingView } from "../keyboardController";
import { SettingsSelect } from "../components/SettingsSelect";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEME_OPTIONS } from "../theme/visualThemes";

export function SettingsScreen() {
  const styles = useAppStyles();
  const { themeId, selectTheme } = useVisualTheme();
  const { openSkiaBoardScreen, openDrawer } = useAppShell();
  const [buildStampCopied, setBuildStampCopied] = useState(false);
  const buildStampCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (buildStampCopiedTimerRef.current) clearTimeout(buildStampCopiedTimerRef.current);
  }, []);

  const copyBuildStamp = async () => {
    await setStringAsync(BUILD_STAMP);
    setBuildStampCopied(true);
    if (buildStampCopiedTimerRef.current) clearTimeout(buildStampCopiedTimerRef.current);
    buildStampCopiedTimerRef.current = setTimeout(() => setBuildStampCopied(false), 2000);
  };

  return (
    <KeyboardAvoidingView
      style={styles.settingsScreen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      automaticOffset={Platform.OS === "ios"}
    >
      <ScrollView
        contentContainerStyle={styles.settingsContent}
        keyboardShouldPersistTaps="handled"
      >
      <TouchableOpacity
        style={styles.settingsBackButton}
        onPress={() => {
          openSkiaBoardScreen();
          openDrawer();
        }}
        accessibilityRole="button"
        accessibilityLabel="メニューに戻る"
      >
        <Text style={styles.settingsBackButtonText}>‹ メニュー</Text>
      </TouchableOpacity>
      <View>
        <Text style={styles.settingsTitle}>設定</Text>
      </View>
      <ConnectionSettings />
      <SpeechSettings />
      <VoiceConversationSettings />
      <GoogleCloudSettings />
      <CodexAccountSettings />
      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>表示</Text>
        </View>
        <View style={styles.settingsGroup}>
          <SettingsSelect
            icon="contrast-outline"
            label="表示テーマ"
            description="配色・文字サイズ・境界線をまとめて切り替えます"
            options={VISUAL_THEME_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
              description: option.description,
            }))}
            selectedValue={themeId}
            onSelect={selectTheme}
            showDivider={false}
          />
        </View>
      </View>
      <View style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>アプリ情報</Text>
        </View>
        <View style={styles.settingsGroup}>
          <View style={styles.settingsRow}>
            <View style={styles.settingsRowLabelWrap}>
              <Text style={styles.settingsRowLabel}>ビルド</Text>
              <Text style={styles.settingsRowDescription} numberOfLines={1}>
                {BUILD_STAMP}
              </Text>
            </View>
            <TouchableOpacity
              onPress={copyBuildStamp}
              accessibilityRole="button"
              accessibilityLabel="ビルドIDをコピー"
            >
              <Text style={styles.settingsActionText}>
                {buildStampCopied ? "コピーしました" : "コピー"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
