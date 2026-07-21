import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
} from "react-native";

export type OptionSelectItem = {
  value: string;
  label: string;
};

type Props = {
  title: string;
  options: readonly OptionSelectItem[];
  selectedValue: string;
  onSelect: (value: string) => void;
};

export function OptionSelectField({ title, options, selectedValue, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === selectedValue);

  return (
    <>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text style={styles.fieldText} numberOfLines={1}>
          {selected?.label ?? selectedValue}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{title}</Text>
            <ScrollView bounces={false}>
              {options.map((option) => {
                const isSelected = option.value === selectedValue;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.option, isSelected && styles.optionSelected]}
                    onPress={() => {
                      onSelect(option.value);
                      setOpen(false);
                    }}
                  >
                    <Text
                      style={[styles.optionText, isSelected && styles.optionTextSelected]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: 40, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, backgroundColor: "#fff" },
  fieldText: { flex: 1, fontSize: 15, color: "#0f172a" },
  chevron: { fontSize: 13, color: "#64748b" },
  backdrop: { flex: 1, backgroundColor: "rgba(17,24,39,0.45)", justifyContent: "center", padding: 20 },
  card: { borderRadius: 12, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e5e7eb", padding: 10, gap: 8, maxHeight: "70%" },
  title: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 4 },
  option: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8 },
  optionSelected: { borderColor: "#0f766e", backgroundColor: "#ecfeff" },
  optionText: { fontSize: 14, color: "#111827", fontWeight: "600" },
  optionTextSelected: { color: "#0f766e" },
});
