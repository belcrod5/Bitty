import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { styles } from "../styles";

export type SlashCommandOption = {
  command: string;
  description: string;
};

type SlashCommandSelectMenuProps = {
  visible: boolean;
  presentation?: "modal" | "inline";
  options: readonly SlashCommandOption[];
  onClose: () => void;
  onSelect: (command: string) => void;
};

export function SlashCommandSelectMenu({
  visible,
  presentation = "modal",
  options,
  onClose,
  onSelect,
}: SlashCommandSelectMenuProps) {
  const content = (
    <Pressable style={styles.modalBackdrop} onPress={onClose}>
      <Pressable style={styles.modalCard} onPress={() => {}}>
        <Text style={styles.modalTitle}>Slash Commands</Text>
        {options.map((item) => (
          <TouchableOpacity
            key={item.command}
            style={styles.modalOption}
            onPress={() => {
              onClose();
              onSelect(item.command);
            }}
          >
            <Text style={styles.modalOptionText}>{item.command}</Text>
            <Text style={styles.modalOptionSubText}>{item.description}</Text>
          </TouchableOpacity>
        ))}
      </Pressable>
    </Pressable>
  );

  if (presentation === "inline") {
    if (!visible) return null;
    return (
      <View pointerEvents="auto" style={localStyles.inlineOverlay}>
        {content}
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

const localStyles = StyleSheet.create({
  inlineOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
  },
});
