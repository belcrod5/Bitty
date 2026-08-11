import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { SkiaBoardSection } from "../utils/skiaBoardState";

export const SKIA_BOARD_SECTION_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#64748b",
];

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
    <Modal visible={!!section} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <SafeAreaView style={styles.safeArea}>
          <Pressable style={styles.panel} onPress={() => {}}>
            <Text style={styles.title}>セクション</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="ラベル"
              selectTextOnFocus
              style={styles.input}
              accessibilityLabel="セクションのラベル"
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
                  {color === option ? <Ionicons name="checkmark" size={18} color="#ffffff" /> : null}
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
                <Ionicons name="remove" size={18} color="#334155" />
              </TouchableOpacity>
              <Text style={styles.value}>{opacityPercent}%</Text>
              <TouchableOpacity
                style={styles.stepButton}
                onPress={() => setOpacity((current) => Number(Math.min(1, current + 0.1).toFixed(1)))}
                accessibilityLabel="透明度を上げる"
              >
                <Ionicons name="add" size={18} color="#334155" />
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
                color={borderOnly ? "#2563eb" : "#64748b"}
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.28)" },
  safeArea: { flex: 1, justifyContent: "center", padding: 24 },
  panel: { padding: 18, borderRadius: 16, backgroundColor: "#ffffff", gap: 12 },
  title: { color: "#172033", fontSize: 17, fontWeight: "800" },
  caption: { color: "#475569", fontSize: 12, fontWeight: "700" },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#94a3b8",
    borderRadius: 9,
    color: "#172033",
    backgroundColor: "#f8fafc",
  },
  colors: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  colorButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  colorSelected: { borderWidth: 3, borderColor: "#dbeafe" },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  rowLabel: { color: "#334155", fontSize: 13, fontWeight: "700" },
  stepButton: { width: 40, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#f1f5f9" },
  value: { minWidth: 38, color: "#475569", fontSize: 12, textAlign: "center" },
  toggleRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 9 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  actionSpacer: { flex: 1 },
  deleteButton: { minHeight: 40, paddingHorizontal: 10, justifyContent: "center" },
  deleteText: { color: "#dc2626", fontSize: 13, fontWeight: "700" },
  cancelButton: { minHeight: 40, paddingHorizontal: 12, justifyContent: "center" },
  cancelText: { color: "#475569", fontSize: 13, fontWeight: "700" },
  saveButton: { minHeight: 40, paddingHorizontal: 16, borderRadius: 9, justifyContent: "center", backgroundColor: "#2563eb" },
  saveText: { color: "#ffffff", fontSize: 13, fontWeight: "800" },
});
