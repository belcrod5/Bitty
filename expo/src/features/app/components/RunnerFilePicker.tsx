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
} from "./RunnerFileExplorer";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

type Props = {
  title: string;
  accessibilityLabel: string;
  closeAccessibilityLabel: string;
  runnerUrl: string;
  runnerToken: string;
  rootPath: string;
  rootDisplayName: string;
  value: string;
  placeholder: string;
  fileFilter: (entry: RunnerFileExplorerEntry) => boolean;
  fileAccessibilityLabel: (entry: RunnerFileExplorerEntry) => string;
  onSelect: (path: string) => void;
};

export function RunnerFilePicker({
  title,
  accessibilityLabel,
  closeAccessibilityLabel,
  runnerUrl,
  runnerToken,
  rootPath,
  rootDisplayName,
  value,
  placeholder,
  fileFilter,
  fileAccessibilityLabel,
  onSelect,
}: Props) {
  const [visible, setVisible] = useState(false);
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={styles.field}
        onPress={() => setVisible(true)}
      >
        <Text style={value ? styles.value : styles.placeholder} numberOfLines={2}>
          {value || placeholder}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setVisible(false)}>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={closeAccessibilityLabel} onPress={() => setVisible(false)}>
              <Text style={styles.headerAction}>閉じる</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{title}</Text>
            <View style={styles.headerSpacer} />
          </View>
          <Text style={styles.path} numberOfLines={2}>{rootDisplayName}</Text>
          <ScrollView contentContainerStyle={styles.content}>
            <RunnerFileExplorer
              active={visible}
              runnerUrl={runnerUrl}
              runnerToken={runnerToken}
              rootPath={rootPath}
              rootDisplayName={rootDisplayName}
              fileFilter={fileFilter}
              fileAccessibilityLabel={fileAccessibilityLabel}
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

function createRunnerFilePickerStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.surfaceRaised },
  field: { minHeight: 44, paddingHorizontal: 10, borderWidth: theme.borders.thin, borderColor: theme.colors.border, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  value: { flex: 1, color: theme.colors.textPrimary, fontSize: theme.typography.compact.fontSize },
  placeholder: { flex: 1, color: theme.colors.borderStrong, fontSize: theme.typography.body.fontSize },
  chevron: { color: theme.colors.textMuted, fontSize: theme.typography.headline.fontSize },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface },
  headerAction: { color: theme.colors.accent, fontSize: theme.typography.control.fontSize, minWidth: 48 },
  headerSpacer: { width: 48 },
  title: { fontSize: theme.typography.subtitle.fontSize, fontWeight: "700", color: theme.colors.textPrimary },
  path: { paddingHorizontal: 16, paddingVertical: 12, color: theme.tones.neutral.foreground, backgroundColor: theme.colors.surface, fontSize: theme.typography.small.fontSize },
  content: { padding: 12 },
  });
}

const stylesByTheme: Record<VisualThemeId, ReturnType<typeof createRunnerFilePickerStyles>> = {
  standard: createRunnerFilePickerStyles(VISUAL_THEMES.standard),
  highLegibility: createRunnerFilePickerStyles(VISUAL_THEMES.highLegibility),
};
