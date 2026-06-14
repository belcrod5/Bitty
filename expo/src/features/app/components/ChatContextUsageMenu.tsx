import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TouchableOpacity, View } from "react-native";
import { styles } from "../styles";
import { CircularProgressRing } from "./CircularProgressRing";

type ChatContextUsageMenuProps = {
  dismissed?: boolean;
  contextPctText: string;
  directoryPath: string;
  progress: number;
  progressColor: string;
  trackColor: string;
  onStartNewSession: () => void;
};

export function ChatContextUsageMenu({
  dismissed = false,
  contextPctText,
  directoryPath,
  progress,
  progressColor,
  trackColor,
  onStartNewSession,
}: ChatContextUsageMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (dismissed) setMenuOpen(false);
  }, [dismissed]);

  return (
    <>
      <View style={styles.chatContextRingWrap}>
        <CircularProgressRing
          size={36}
          strokeWidth={3}
          progress={progress}
          trackColor={trackColor}
          progressColor={progressColor}
        />
        <TouchableOpacity
          style={styles.chatContextResetButton}
          onLongPress={() => setMenuOpen(true)}
          disabled={dismissed}
          delayLongPress={450}
          accessibilityRole="button"
          accessibilityLabel={`コンテキスト使用量 ${contextPctText}%`}
          accessibilityHint="長押しすると新規セッションメニューを開きます"
        >
          <Text style={styles.chatContextPctText}>{contextPctText}%</Text>
        </TouchableOpacity>
      </View>
      <Modal
        visible={menuOpen && !dismissed}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>コンテキスト</Text>
            <TouchableOpacity
              style={styles.modalOption}
              onPress={() => {
                setMenuOpen(false);
                onStartNewSession();
              }}
            >
              <Text style={styles.modalOptionText}>同じディレクトリーで新規セッション</Text>
              <Text style={styles.modalOptionSubText} numberOfLines={2}>
                {directoryPath}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
