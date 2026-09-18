import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
} from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

export type OptionSelectItem = {
  value: string;
  label: string;
};

type Props = {
  title: string;
  options: readonly OptionSelectItem[];
  selectedValue: string;
  onSelect: (value: string) => void;
  accessibilityLabel?: string;
};

export function OptionSelectField({
  title,
  options,
  selectedValue,
  onSelect,
  accessibilityLabel = title,
}: Props) {
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === selectedValue);

  return (
    <>
      <TouchableOpacity
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        style={styles.field}
        onPress={() => setOpen(true)}
      >
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
                    accessibilityRole="button"
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

function createOptionSelectStyles(theme: VisualTheme) {
  return StyleSheet.create({
    field: { minHeight: 40, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: theme.borders.thin, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface },
    fieldText: { flex: 1, fontSize: theme.typography.input.fontSize, color: theme.colors.textPrimary },
    chevron: { fontSize: theme.typography.compact.fontSize, color: theme.colors.textMuted },
    backdrop: { flex: 1, backgroundColor: theme.colors.controlBackdropStrong, justifyContent: "center", padding: 20 },
    card: { borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: theme.borders.thin, borderColor: theme.colors.borderSoft, padding: 10, gap: 8, maxHeight: "70%" },
    title: { fontSize: theme.typography.control.fontSize, fontWeight: "700", color: theme.colors.controlTextPrimary, marginBottom: 4 },
    option: { borderWidth: theme.borders.thin, borderColor: theme.colors.borderSoft, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8 },
    optionSelected: { borderColor: theme.colors.primaryAction, backgroundColor: theme.colors.primaryActionSelected },
    optionText: { fontSize: theme.typography.body.fontSize, color: theme.colors.controlTextPrimary, fontWeight: "600" },
    optionTextSelected: { color: theme.colors.primaryAction },
  });
}

const stylesByTheme: Record<VisualThemeId, ReturnType<typeof createOptionSelectStyles>> = {
  standard: createOptionSelectStyles(VISUAL_THEMES.standard),
  highLegibility: createOptionSelectStyles(VISUAL_THEMES.highLegibility),
};
