import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "../keyboardController";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";
import { getRunnerFileLocation, getRunnerMediaKind } from "../utils/runnerFileContextMenu";
import { AppModal } from "./AppModal";
import { OptionSelectField } from "./OptionSelectField";
import { RunnerFilePicker } from "./RunnerFilePicker";
import type { RunnerFileExplorerEntry } from "./RunnerFileExplorer";

export type SkiaBoardAppearanceTarget = {
  cardId: string;
  name: string;
  rootPath: string;
  displayNameOverride?: string;
  imagePath?: string;
};

const isImageFile = (entry: RunnerFileExplorerEntry) => getRunnerMediaKind(entry.path) === "image";

export function SkiaBoardCardAppearanceEditor({
  target,
  directories,
  runnerUrl,
  runnerToken,
  onClose,
  onSave,
}: {
  target: SkiaBoardAppearanceTarget | null;
  directories: readonly { path: string; displayName: string }[];
  runnerUrl: string;
  runnerToken: string;
  onClose: () => void;
  onSave: (appearance: { displayNameOverride?: string; imagePath?: string }) => void;
}) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [displayName, setDisplayName] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [rootPath, setRootPath] = useState("");

  useEffect(() => {
    setDisplayName(target?.displayNameOverride || "");
    setImagePath(target?.imagePath || "");
    const imageDirectory = target?.imagePath
      ? getRunnerFileLocation(target.imagePath, target.rootPath).rootDirectory
      : "";
    setRootPath(
      () =>
        directories.find((directory) => target?.imagePath?.startsWith(`${directory.path}/`))?.path ||
        imageDirectory ||
        target?.rootPath ||
        directories[0]?.path ||
        "",
    );
  }, [directories, target]);

  const directoryOptions = useMemo(
    () => [
      ...directories.map((directory) => ({
        value: directory.path,
        label: directory.displayName || directory.path,
      })),
      ...(rootPath && !directories.some((directory) => directory.path === rootPath)
        ? [{ value: rootPath, label: `登録解除済み: ${rootPath}` }]
        : []),
    ],
    [directories, rootPath],
  );

  const save = () => {
    const nextDisplayName = displayName.trim();
    const nextImagePath = imagePath.trim();
    onSave({
      ...(nextDisplayName ? { displayNameOverride: nextDisplayName } : {}),
      ...(nextImagePath ? { imagePath: nextImagePath } : {}),
    });
  };

  return (
    <AppModal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoiding}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          automaticOffset={Platform.OS === "ios"}
        >
          <SafeAreaView style={styles.safeArea}>
            <Pressable style={styles.panel} onPress={() => {}}>
              <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <Text style={styles.title}>カード表示</Text>
                <Text style={styles.currentName} numberOfLines={1}>
                  {target?.name || ""}
                </Text>
                <Text style={styles.label}>ボード上の表示名</Text>
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="空欄で通常名を使用"
                  placeholderTextColor={theme.colors.textMuted}
                  selectTextOnFocus
                  style={styles.input}
                  accessibilityLabel="ボード上の表示名"
                />
                <Text style={styles.label}>カード画像</Text>
                <Text style={styles.label}>ディレクトリ</Text>
                <OptionSelectField
                  title="ディレクトリ"
                  accessibilityLabel="画像を探すディレクトリ"
                  options={directoryOptions}
                  selectedValue={rootPath}
                  onSelect={(directory) => {
                    setRootPath(directory);
                    setImagePath("");
                  }}
                />
                {rootPath ? (
                  <>
                    <Text style={styles.label}>ファイル</Text>
                    <RunnerFilePicker
                      title="カード画像"
                      accessibilityLabel="カード画像"
                      closeAccessibilityLabel="カード画像選択を閉じる"
                      runnerUrl={runnerUrl}
                      runnerToken={runnerToken}
                      rootPath={rootPath}
                      rootDisplayName={directoryOptions.find((option) => option.value === rootPath)?.label || rootPath}
                      value={imagePath}
                      placeholder="画像ファイルを選択"
                      fileFilter={isImageFile}
                      fileAccessibilityLabel={(entry) => `${entry.name}を画像として選択`}
                      onSelect={setImagePath}
                    />
                  </>
                ) : (
                  <Text style={styles.help}>画像を選ぶには登録済みのディレクトリが必要です。</Text>
                )}
                {imagePath ? (
                  <View style={styles.imageSelection}>
                    <Text style={styles.imagePath} selectable>{imagePath}</Text>
                    <TouchableOpacity
                      onPress={() => setImagePath("")}
                      accessibilityRole="button"
                      accessibilityLabel="選択した画像を解除"
                    >
                      <Text style={styles.clearImageText}>画像を解除</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                <Text style={styles.help}>保存すると選択中の画像と表示名を反映します。</Text>
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.resetButton}
                    onPress={() => onSave({})}
                    accessibilityRole="button"
                    accessibilityLabel="カード表示を初期状態へリセット"
                  >
                    <Text style={styles.resetText}>リセット</Text>
                  </TouchableOpacity>
                  <View style={styles.spacer} />
                  <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                    <Text style={styles.cancelText}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveButton} onPress={save}>
                    <Text style={styles.saveText}>保存</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </Pressable>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Pressable>
    </AppModal>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: theme.colors.backdrop },
    keyboardAvoiding: { flex: 1 },
    safeArea: { flex: 1, justifyContent: "center", padding: 24 },
    panel: {
      maxHeight: "100%",
      borderRadius: 16,
      backgroundColor: theme.colors.surface,
    },
    content: { padding: 18, gap: 10 },
    title: {
      color: theme.colors.textPrimary,
      fontSize: theme.typography.subtitle.fontSize,
      lineHeight: theme.typography.subtitle.lineHeight,
      fontWeight: "800",
    },
    currentName: { color: theme.colors.textMuted, ...theme.typography.small },
    label: {
      color: theme.colors.formLabel,
      fontSize: theme.typography.small.fontSize,
      lineHeight: theme.typography.small.lineHeight,
      fontWeight: "700",
      marginTop: 2,
    },
    input: {
      minHeight: 44,
      paddingHorizontal: 12,
      borderWidth: theme.borders.thin,
      borderColor: theme.colors.borderStrong,
      borderRadius: 9,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.surfaceRaised,
      fontSize: theme.typography.input.fontSize,
      lineHeight: theme.typography.input.lineHeight,
    },
    help: { color: theme.colors.textMuted, ...theme.typography.caption },
    imageSelection: {
      gap: 6,
      padding: 10,
      borderRadius: 9,
      backgroundColor: theme.colors.surfaceMuted,
    },
    imagePath: { color: theme.colors.textSecondary, ...theme.typography.small },
    clearImageText: {
      color: theme.colors.negativeText,
      fontSize: theme.typography.small.fontSize,
      lineHeight: theme.typography.small.lineHeight,
      fontWeight: "700",
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 4,
    },
    spacer: { flex: 1 },
    resetButton: {
      minHeight: 40,
      paddingHorizontal: 8,
      justifyContent: "center",
    },
    resetText: {
      color: theme.colors.negativeText,
      fontSize: theme.typography.compact.fontSize,
      lineHeight: theme.typography.compact.lineHeight,
      fontWeight: "700",
    },
    cancelButton: {
      minHeight: 40,
      paddingHorizontal: 10,
      justifyContent: "center",
    },
    cancelText: {
      color: theme.colors.textSecondary,
      fontSize: theme.typography.compact.fontSize,
      lineHeight: theme.typography.compact.lineHeight,
      fontWeight: "700",
    },
    saveButton: {
      minHeight: 40,
      paddingHorizontal: 16,
      borderRadius: 9,
      justifyContent: "center",
      backgroundColor: theme.colors.accent,
    },
    saveText: {
      color: theme.colors.textOnAccent,
      fontSize: theme.typography.compact.fontSize,
      lineHeight: theme.typography.compact.lineHeight,
      fontWeight: "800",
    },
  });
}

const stylesByTheme: Record<VisualThemeId, ReturnType<typeof createStyles>> = {
  standard: createStyles(VISUAL_THEMES.standard),
  highLegibility: createStyles(VISUAL_THEMES.highLegibility),
};
