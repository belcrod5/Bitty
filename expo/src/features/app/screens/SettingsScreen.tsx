import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { ConnectionSettings } from "../components/ConnectionSettings";
import { SpeechSettings } from "../components/SpeechSettings";
import { useAppShell } from "../contexts/AppShellContext";
import { styles } from "../styles";

export function SettingsScreen() {
  const { openSkiaBoardScreen, openDrawer } = useAppShell();

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
    </ScrollView>
  );
}
