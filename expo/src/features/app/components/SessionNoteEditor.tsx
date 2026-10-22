import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { useVisualTheme } from "../theme/VisualThemeContext";

type Props = {
  note: string;
  onSave: (note: string, expectedNote: string) => Promise<void>;
  onClose: () => void;
};

export function SessionNoteEditor({ note, onSave, onClose }: Props) {
  const styles = useAppStyles();
  const { theme } = useVisualTheme();
  const [originalNote] = useState(note);
  const [text, setText] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(text, originalNote);
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <View style={styles.chatDirectoryRenameBlock} testID="session-note-editor">
      <Text style={styles.settingsRowDescription}>再開時に思い出したいことを保存できます。LLMには送信されません。</Text>
      <TextInput
        style={[styles.chatDirectoryRenameInput, { minHeight: 120, maxHeight: 260, textAlignVertical: "top" }]}
        accessibilityLabel="セッションメモ"
        value={text}
        onChangeText={setText}
        placeholder="作業の状況や、後で確認したいこと"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        maxLength={100_000}
        editable={!saving}
        autoCapitalize="none"
      />
      {error ? <Text accessibilityRole="alert" style={styles.settingsDangerText}>{error}</Text> : null}
      <View style={styles.chatDirectoryRenameActions}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="メモを保存"
          style={styles.chatDirectoryRenamePrimaryButton}
          onPress={() => { void save(); }}
          disabled={saving}
        >
          {saving ? <ActivityIndicator color={theme.colors.textOnAccent} /> : <Text style={styles.chatDirectoryRenamePrimaryButtonText}>保存</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="メモ編集をキャンセル"
          style={styles.chatDirectoryRenameSecondaryButton}
          onPress={onClose}
          disabled={saving}
        >
          <Text style={styles.chatDirectoryRenameSecondaryButtonText}>キャンセル</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
