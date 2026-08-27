import { Ionicons } from "@expo/vector-icons";
import { useState, type ComponentProps } from "react";
import { Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { styles } from "../styles";
import { AppModal } from "./AppModal";

export type SettingsSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

type SettingsSelectProps<T extends string> = {
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  options: readonly SettingsSelectOption<T>[];
  selectedValue: T;
  selectedLabel?: string;
  onSelect: (value: T) => void;
  description?: string;
  placeholder?: string;
  loading?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onOpen?: () => void;
  showDivider?: boolean;
};

export function SettingsSelect<T extends string>({
  icon,
  label,
  options,
  selectedValue,
  selectedLabel: selectedLabelOverride,
  onSelect,
  description,
  placeholder = "選択してください",
  loading = false,
  searchValue,
  onSearchChange,
  searchPlaceholder = "候補を検索",
  onOpen,
  showDivider = true,
}: SettingsSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === selectedValue);
  const selectedLabel = selected?.label || selectedLabelOverride || selectedValue || placeholder;

  const openOptions = () => {
    onOpen?.();
    setOpen(true);
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.settingsRow, showDivider && styles.settingsRowDivider]}
        onPress={openOptions}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selectedLabel }}
      >
        <Ionicons name={icon} size={22} color="#111827" />
        <View style={styles.settingsRowLabelWrap}>
          <Text style={styles.settingsRowLabel}>{label}</Text>
          {description ? <Text style={styles.settingsRowDescription}>{description}</Text> : null}
        </View>
        <Text style={styles.settingsRowValue} numberOfLines={1}>
          {loading ? "取得中…" : selectedLabel}
        </Text>
        <Ionicons name="chevron-expand-outline" size={20} color="#9ca3af" />
      </TouchableOpacity>

      <AppModal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.settingsSelectBackdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={styles.settingsSelectCard}
            onPress={() => {}}
            accessibilityViewIsModal
            accessibilityLabel={`${label}の選択肢`}
          >
            <View style={styles.settingsSelectHeader}>
              <Text style={styles.settingsSelectTitle}>{label}</Text>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel={`${label}を閉じる`}
                style={styles.settingsSelectCloseButton}
              >
                <Ionicons name="close" size={21} color="#4b5563" />
              </TouchableOpacity>
            </View>
            {onSearchChange ? (
              <TextInput
                style={styles.settingsSelectSearchInput}
                value={searchValue}
                onChangeText={onSearchChange}
                placeholder={searchPlaceholder}
                autoCorrect={false}
                accessibilityLabel={`${label}を検索`}
              />
            ) : null}
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
              {options.map((option) => {
                const selectedOption = option.value === selectedValue;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={styles.settingsSelectOption}
                    onPress={() => {
                      onSelect(option.value);
                      setOpen(false);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedOption }}
                  >
                    <View style={styles.settingsSelectOptionTextWrap}>
                      <Text style={[styles.settingsSelectOptionLabel, selectedOption && styles.settingsSelectOptionLabelSelected]}>
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text style={styles.settingsSelectOptionDescription}>{option.description}</Text>
                      ) : null}
                    </View>
                    {selectedOption ? <Ionicons name="checkmark" size={20} color="#0a84ff" /> : null}
                  </TouchableOpacity>
                );
              })}
              {!loading && options.length === 0 ? (
                <Text style={styles.settingsSelectEmpty}>候補がありません。</Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </AppModal>
    </>
  );
}
