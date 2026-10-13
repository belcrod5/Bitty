import { useEffect, useState } from "react";
import { Platform, Pressable, Text, TouchableOpacity } from "react-native";
import { useAppStyles } from "../styles";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { AppModal } from "./AppModal";

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
  const styles = useAppStyles();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (dismissed) setMenuOpen(false);
  }, [dismissed]);

  return (
    <>
      <ContextUsageIndicator contextPctText={contextPctText} progress={progress}
        trackColor={trackColor} progressColor={progressColor}
        onLongPress={() => setMenuOpen(true)} disabled={dismissed}
        accessibilityHint="長押しすると新規セッションメニューを開きます" />
      <AppModal
        visible={menuOpen && !dismissed}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable
            testID="chat-context-menu"
            style={[styles.modalCard, Platform.OS === "macos" && styles.chatContentWidth]}
            onPress={() => {}}
          >
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
      </AppModal>
    </>
  );
}
