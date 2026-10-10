import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { RunnerFileTarget } from "../utils/runnerFileContextMenu";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";
import { WorkspaceFileRenameDialog } from "./WorkspaceFileRenameDialog";

type FileViewerHeaderAction = {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  testID?: string;
};

type FileViewerHeaderProps = {
  target: RunnerFileTarget;
  onClose: () => void;
  onRequestClose?: () => void;
  saving: boolean;
  actions?: FileViewerHeaderAction[];
  beforeMutation?: () => boolean;
  onBusyChange: (busy: boolean) => void;
  closeTestID?: string;
};

export function FileViewerHeader({
  target,
  onClose,
  onRequestClose = onClose,
  saving,
  actions = [],
  beforeMutation,
  onBusyChange,
  closeTestID,
}: FileViewerHeaderProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [renameTarget, setRenameTarget] = useState<WorkspaceFileTarget | null>(null);
  const [mutating, setMutating] = useState(false);
  const current = useRef<{
    target: RunnerFileTarget;
    saving: boolean;
    beforeMutation?: () => boolean;
  }>({ target, saving, beforeMutation });
  current.current = { target, saving, beforeMutation };
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const disabled = saving || mutating || renameTarget !== null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const canMutate = () => mounted.current
    && !current.current.saving
    && !busyRef.current
    && (current.current.beforeMutation?.() ?? true);

  const openMenu = () => {
    if (disabled) return;
    target.openContextMenu?.({
      onRequestRename: target.renameFile ? (file) => {
        if (current.current.target !== target || !canMutate()) return;
        onBusyChange(true);
        setRenameTarget(file);
      } : undefined,
      onRequestDelete: target.deleteFile ? async (file) => {
        if (current.current.target !== target || !canMutate()) return false;
        busyRef.current = true;
        setMutating(true);
        onBusyChange(true);
        try {
          const result = await target.deleteFile!(file);
          if (result !== false && mounted.current && current.current.target === target) onClose();
          return result;
        } catch {
          return false;
        } finally {
          busyRef.current = false;
          if (mounted.current && current.current.target === target) {
            setMutating(false);
            onBusyChange(false);
          }
        }
      } : undefined,
    });
  };

  const rename = async (name: string) => {
    if (!renameTarget || !target.renameFile || !canMutate()) return;
    busyRef.current = true;
    setMutating(true);
    try {
      await target.renameFile(renameTarget, name);
      if (mounted.current && current.current.target === target) {
        setRenameTarget(null);
        onBusyChange(false);
        onClose();
      }
    } finally {
      busyRef.current = false;
      if (mounted.current && current.current.target === target) setMutating(false);
    }
  };

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{target.name || "ファイル"}</Text>
        {actions.map((action) => (
          <TouchableOpacity
            key={action.label}
            style={[
              styles.button,
              (disabled || action.disabled) ? styles.disabled : null,
            ]}
            onPress={action.onPress}
            disabled={disabled || action.disabled}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: disabled || Boolean(action.disabled) }}
            testID={action.testID}
          >
            <Ionicons
              name={action.icon}
              size={22}
              color={action.primary ? theme.colors.primaryAction : theme.colors.textSecondary}
            />
          </TouchableOpacity>
        ))}
        {saving || mutating ? (
          <ActivityIndicator
            size="small"
            color={theme.colors.primaryAction}
            accessibilityLabel={saving ? "保存中" : "ファイル操作中"}
          />
        ) : null}
        {target.openContextMenu ? (
          <TouchableOpacity
            style={[styles.button, disabled ? styles.disabled : null]}
            onPress={openMenu}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="ファイルの操作メニューを開く"
            accessibilityState={{ disabled }}
          >
            <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.button, disabled ? styles.disabled : null]}
          onPress={onRequestClose}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={saving ? "保存中はファイルビューアーを閉じられません" : "ファイルビューアーを閉じる"}
          accessibilityState={{ disabled }}
          testID={closeTestID}
        >
          <Ionicons name="close" size={24} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <WorkspaceFileRenameDialog
        target={renameTarget}
        onCancel={() => {
          setRenameTarget(null);
          onBusyChange(false);
        }}
        onRename={rename}
      />
    </>
  );
}

function createHeaderStyles(theme: VisualTheme) {
  return StyleSheet.create({
    header: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingVertical: 4,
      gap: 4,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: theme.borders.thin,
      borderBottomColor: theme.colors.borderSubtle,
    },
    title: {
      flex: 1,
      minWidth: 0,
      paddingLeft: 4,
      color: theme.colors.textPrimary,
      fontSize: theme.typography.input.fontSize,
      fontWeight: "700",
    },
    button: {
      width: 44,
      height: 44,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    disabled: { opacity: 0.5 },
  });
}

const stylesByTheme = createStylesByTheme(createHeaderStyles);
