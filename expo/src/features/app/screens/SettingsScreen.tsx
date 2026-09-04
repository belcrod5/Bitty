import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { setStringAsync } from "../clipboard";
import { ConnectionSettings } from "../components/ConnectionSettings";
import { SpeechSettings } from "../components/SpeechSettings";
import { useAppShell } from "../contexts/AppShellContext";
import { BUILD_STAMP } from "../buildStamp";
import { styles } from "../styles";

export function SettingsScreen() {
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
    <ScrollView
      style={styles.settingsScreen}
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
  );
}
