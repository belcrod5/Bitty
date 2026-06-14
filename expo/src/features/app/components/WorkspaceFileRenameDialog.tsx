import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";

type WorkspaceFileRenameDialogProps = {
  target: WorkspaceFileTarget | null;
  onCancel: () => void;
  onRename: (name: string) => Promise<void>;
};

export function WorkspaceFileRenameDialog({
  target,
  onCancel,
  onRename,
}: WorkspaceFileRenameDialogProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    setName(target?.name || "");
    setSaving(false);
    if (!target) return;
    const timeout = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timeout);
  }, [target]);

  const submit = () => {
    const nextName = name.trim();
    if (!target || !nextName || saving) return;
    setSaving(true);
    void onRename(nextName).catch(() => {
      setSaving(false);
    });
  };

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={saving ? undefined : onCancel}
    >
      <Pressable style={dialogStyles.backdrop} onPress={saving ? undefined : onCancel}>
        <Pressable style={dialogStyles.card} onPress={() => {}}>
          <Text style={dialogStyles.title}>ファイル名を変更</Text>
          <Text style={dialogStyles.path} numberOfLines={2}>{target?.path || ""}</Text>
          <TextInput
            ref={inputRef}
            style={dialogStyles.input}
            value={name}
            onChangeText={setName}
            onSubmitEditing={submit}
            editable={!saving}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            selectTextOnFocus
          />
          <View style={dialogStyles.actions}>
            <TouchableOpacity
              style={dialogStyles.secondaryButton}
              onPress={onCancel}
              disabled={saving}
            >
              <Text style={dialogStyles.secondaryButtonText}>キャンセル</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                dialogStyles.primaryButton,
                (!name.trim() || saving) ? dialogStyles.disabledButton : null,
              ]}
              onPress={submit}
              disabled={!name.trim() || saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={dialogStyles.primaryButtonText}>変更</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const dialogStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#ffffff",
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  path: {
    fontSize: 12,
    color: "#64748b",
  },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#0f172a",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    color: "#334155",
    fontWeight: "600",
  },
  primaryButton: {
    minWidth: 72,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: "#0f766e",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.5,
  },
});
