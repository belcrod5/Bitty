import { useEffect, useState } from "react";
import { Keyboard, Pressable, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppModal } from "./AppModal";
import type { SkiaBoardSection } from "../utils/skiaBoardState";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export const SKIA_BOARD_SECTION_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#22c55e", "#64748b"];

export function SkiaBoardSectionEditor({
  section,
  onClose,
  onSave,
  onDelete,
}: {
  section: SkiaBoardSection | null;
  onClose: () => void;
  onSave: (update: Pick<SkiaBoardSection, "label" | "color" | "opacity" | "borderOnly">) => void;
  onDelete: () => void;
}) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(SKIA_BOARD_SECTION_COLORS[0]);
  const [opacity, setOpacity] = useState(0.2);
  const [borderOnly, setBorderOnly] = useState(false);
  useEffect(() => {
    if (!section) return;
    setLabel(section.label);
    setColor(section.color);
    setOpacity(section.opacity);
    setBorderOnly(section.borderOnly);
  }, [section]);
  const opacityPercent = Math.round(opacity * 100);
  return (
    <AppModal visible={!!section} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <SafeAreaView style={styles.safeArea}>
          <Pressable
            style={styles.panel}
            onPress={() => {}}
            onTouchStart={Keyboard.dismiss}
            testID="skia-board-section-editor-panel"
          >
            <Text style={styles.title}>セクション</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="ラベル"
              placeholderTextColor={theme.colors.textMuted}
              selectTextOnFocus
              style={styles.input}
              accessibilityLabel="セクションのラベル"
              onTouchStart={(event) => event.stopPropagation()}
            />
            <Text style={styles.caption}>背景色</Text>
            <View style={styles.colors}>
              {SKIA_BOARD_SECTION_COLORS.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.colorButton, { backgroundColor: option }, color === option && styles.colorSelected]}
                  onPress={() => setColor(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`背景色 ${option}`}
                >
                  {color === option ? <Ionicons name="checkmark" size={18} color={theme.colors.textOnAccent} /> : null}
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>透明度</Text>
              <TouchableOpacity
                style={styles.stepButton}
                onPress={() => setOpacity((current) => Number(Math.max(0, current - 0.1).toFixed(1)))}
                accessibilityLabel="透明度を下げる"
              >
                <Ionicons name="remove" size={18} color={theme.colors.iconSecondary} />
              </TouchableOpacity>
              <Text style={styles.value}>{opacityPercent}%</Text>
              <TouchableOpacity
                style={styles.stepButton}
                onPress={() => setOpacity((current) => Number(Math.min(1, current + 0.1).toFixed(1)))}
                accessibilityLabel="透明度を上げる"
              >
                <Ionicons name="add" size={18} color={theme.colors.iconSecondary} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.toggleRow}
              onPress={() => setBorderOnly((current) => !current)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: borderOnly }}
              accessibilityLabel="ボーダーのみ"
            >
              <Ionicons
                name={borderOnly ? "checkbox" : "square-outline"}
                size={22}
                color={borderOnly ? theme.colors.accent : theme.colors.iconMuted}
              />
              <Text style={styles.rowLabel}>ボーダーのみ</Text>
            </TouchableOpacity>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
                <Text style={styles.deleteText}>削除</Text>
              </TouchableOpacity>
              <View style={styles.actionSpacer} />
              <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                <Text style={styles.cancelText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveButton}
                onPress={() => onSave({
                  label: label.trim() || "セクション",
                  color,
                  opacity: Number(opacity.toFixed(1)),
                  borderOnly,
                })}
              >
                <Text style={styles.saveText}>保存</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </AppModal>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: theme.colors.backdrop },
    safeArea: { flex: 1, justifyContent: "center", padding: 24 },
    panel: {
      padding: 18,
      borderRadius: 16,
      backgroundColor: theme.colors.surface,
      gap: 12,
    },
    title: {
      color: theme.colors.textPrimary,
      fontSize: theme.typography.subtitle.fontSize,
      lineHeight: theme.typography.subtitle.lineHeight,
      fontWeight: "800",
    },
    caption: {
      color: theme.colors.formLabel,
      fontSize: theme.typography.small.fontSize,
      lineHeight: theme.typography.small.lineHeight,
      fontWeight: "700",
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
    colors: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    colorButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    colorSelected: {
      borderWidth: theme.borders.focus,
      borderColor: theme.colors.focus,
    },
    row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
    rowLabel: {
      color: theme.colors.textSecondary,
      fontSize: theme.typography.compact.fontSize,
      lineHeight: theme.typography.compact.lineHeight,
      fontWeight: "700",
    },
    stepButton: {
      width: 40,
      height: 40,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceMuted,
    },
    value: {
      minWidth: 38,
      color: theme.colors.textMuted,
      fontSize: theme.typography.small.fontSize,
      lineHeight: theme.typography.small.lineHeight,
      textAlign: "center",
    },
    toggleRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 4,
    },
    actionSpacer: { flex: 1 },
    deleteButton: {
      minHeight: 40,
      paddingHorizontal: 10,
      justifyContent: "center",
    },
    deleteText: {
      color: theme.colors.negativeText,
      fontSize: theme.typography.compact.fontSize,
      lineHeight: theme.typography.compact.lineHeight,
      fontWeight: "700",
    },
    cancelButton: {
      minHeight: 40,
      paddingHorizontal: 12,
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

const stylesByTheme = createStylesByTheme(createStyles);
