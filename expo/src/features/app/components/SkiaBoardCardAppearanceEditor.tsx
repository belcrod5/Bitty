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
import {
  getRunnerFileViewerLocation,
  getRunnerMediaKind,
} from "../utils/runnerFileContextMenu";
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
  const [displayName, setDisplayName] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [rootPath, setRootPath] = useState("");

  useEffect(() => {
    setDisplayName(target?.displayNameOverride || "");
    setImagePath(target?.imagePath || "");
    const imageDirectory = target?.imagePath
      ? getRunnerFileViewerLocation(target.imagePath, target.rootPath).rootDirectory
      : "";
    setRootPath(() => directories.find((directory) => (
      target?.imagePath?.startsWith(`${directory.path}/`)
    ))?.path || imageDirectory || target?.rootPath || directories[0]?.path || "");
  }, [directories, target]);

  const directoryOptions = useMemo(() => [
    ...directories.map((directory) => ({
      value: directory.path,
      label: directory.displayName || directory.path,
    })),
    ...(
      rootPath && !directories.some((directory) => directory.path === rootPath)
        ? [{ value: rootPath, label: `登録解除済み: ${rootPath}` }]
        : []
    ),
  ], [directories, rootPath]);

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
                <Text style={styles.currentName} numberOfLines={1}>{target?.name || ""}</Text>
                <Text style={styles.label}>ボード上の表示名</Text>
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="空欄で通常名を使用"
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

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.28)" },
  keyboardAvoiding: { flex: 1 },
  safeArea: { flex: 1, justifyContent: "center", padding: 24 },
  panel: { maxHeight: "100%", borderRadius: 16, backgroundColor: "#ffffff" },
  content: { padding: 18, gap: 10 },
  title: { color: "#172033", fontSize: 17, fontWeight: "800" },
  currentName: { color: "#64748b", fontSize: 12 },
  label: { color: "#475569", fontSize: 12, fontWeight: "700", marginTop: 2 },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#94a3b8",
    borderRadius: 9,
    color: "#172033",
    backgroundColor: "#f8fafc",
  },
  help: { color: "#64748b", fontSize: 11 },
  imageSelection: { gap: 6, padding: 10, borderRadius: 9, backgroundColor: "#f1f5f9" },
  imagePath: { color: "#334155", fontSize: 12 },
  clearImageText: { color: "#dc2626", fontSize: 12, fontWeight: "700" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  spacer: { flex: 1 },
  resetButton: { minHeight: 40, paddingHorizontal: 8, justifyContent: "center" },
  resetText: { color: "#dc2626", fontSize: 13, fontWeight: "700" },
  cancelButton: { minHeight: 40, paddingHorizontal: 10, justifyContent: "center" },
  cancelText: { color: "#475569", fontSize: 13, fontWeight: "700" },
  saveButton: {
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 9,
    justifyContent: "center",
    backgroundColor: "#2563eb",
  },
  saveText: { color: "#ffffff", fontSize: 13, fontWeight: "800" },
});
