import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useAppShell } from "../contexts/AppShellContext";
import { DebugConnectionPanel } from "../components/DebugConnectionPanel";
import { DebugConversationPanel } from "../components/DebugConversationPanel";
import { DebugSpeechControlsPanel } from "../components/DebugSpeechControlsPanel";
import { styles } from "../styles";

export function DebugScreen() {
  const { openMiniBoardScreen, openDrawer, openAudioLabScreen } = useAppShell();
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.debugHeaderRow}>
        <TouchableOpacity
          style={styles.debugBackButton}
          onPress={() => {
            openMiniBoardScreen();
            openDrawer();
          }}
        >
          <Text style={styles.debugBackButtonText}>← Menu</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.debugLabButton} onPress={openAudioLabScreen}>
          <Text style={styles.debugLabButtonText}>Audio Lab</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.title}>Bitty Local Test (Debug)</Text>

      <DebugConnectionPanel />
      <DebugSpeechControlsPanel />
      <DebugConversationPanel />
    </ScrollView>
  );
}
