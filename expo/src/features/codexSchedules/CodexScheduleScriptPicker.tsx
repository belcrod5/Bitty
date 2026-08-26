import { useState } from "react";
import {
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  RunnerFileExplorer,
  type RunnerFileExplorerEntry,
} from "../app/components/RunnerFileExplorer";

type Props = {
  runnerUrl: string;
  runnerToken: string;
  rootPath: string;
  value: string;
  onSelect: (path: string) => void;
};

const shellScriptsOnly = (entry: RunnerFileExplorerEntry) => entry.name.toLowerCase().endsWith(".sh");

export function CodexScheduleScriptPicker({ runnerUrl, runnerToken, rootPath, value, onSelect }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="実行ファイル"
        style={styles.field}
        onPress={() => setVisible(true)}
      >
        <Text style={value ? styles.value : styles.placeholder} numberOfLines={2}>
          {value || ".sh ファイルを選択"}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setVisible(false)}>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="実行ファイル選択を閉じる" onPress={() => setVisible(false)}>
              <Text style={styles.headerAction}>閉じる</Text>
            </TouchableOpacity>
            <Text style={styles.title}>実行ファイル</Text>
            <View style={styles.headerSpacer} />
          </View>
          <Text style={styles.path} numberOfLines={2}>{rootPath}</Text>
          <ScrollView contentContainerStyle={styles.content}>
            <RunnerFileExplorer
              active={visible}
              runnerUrl={runnerUrl}
              runnerToken={runnerToken}
              rootPath={rootPath}
              rootDisplayName={rootPath}
              fileFilter={shellScriptsOnly}
              fileAccessibilityLabel={(entry) => `${entry.name}を選択`}
              onFilePress={(entry) => {
                onSelect(entry.path);
                setVisible(false);
              }}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  field: { minHeight: 44, paddingHorizontal: 10, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  value: { flex: 1, color: "#0f172a", fontSize: 13 },
  placeholder: { flex: 1, color: "#94a3b8", fontSize: 14 },
  chevron: { color: "#64748b", fontSize: 22 },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#cbd5e1", backgroundColor: "#fff" },
  headerAction: { color: "#2563eb", fontSize: 16, minWidth: 48 },
  headerSpacer: { width: 48 },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  path: { paddingHorizontal: 16, paddingVertical: 12, color: "#475569", backgroundColor: "#fff", fontSize: 12 },
  content: { padding: 12 },
});
