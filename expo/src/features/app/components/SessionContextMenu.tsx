import { Platform, Pressable, Text, TouchableOpacity } from "react-native";
import type { LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import { useConversation } from "../contexts/ConversationContext";
import { useSkiaBoard } from "../contexts/SkiaBoardContext";
import { useAppStyles } from "../styles";
import { AppModal } from "./AppModal";

export type SessionContextMenuTarget = {
  backendId: string;
  sessionId: string;
  source: LlmSessionSource;
  directory: string;
  title: string;
};

export function SessionContextMenu({ target, onClose }: {
  target: SessionContextMenuTarget | null;
  onClose: () => void;
}) {
  const styles = useAppStyles();
  const { markSessionReadManually, markSessionUnread } = useConversation();
  const { loaded, hasSession, addSession, removeSession } = useSkiaBoard();
  if (!target?.sessionId) return null;
  const { backendId, sessionId, source, directory, title } = target;
  return (
    <AppModal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable
          testID="session-context-menu"
          style={[styles.modalCard, Platform.OS === "macos" && styles.chatContentWidth]}
          onPress={() => {}}
        >
          <Text style={styles.modalTitle} numberOfLines={3}>{title || sessionId}</Text>
          <TouchableOpacity style={styles.modalOption} onPress={() => {
            markSessionReadManually({ backendId, sessionId, source, directory });
            onClose();
          }}>
            <Text style={styles.modalOptionText}>既読にする</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalOption} onPress={() => {
            markSessionUnread({ backendId, sessionId, source, directory });
            onClose();
          }}>
            <Text style={styles.modalOptionText}>未読にする</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modalOption, !loaded && styles.buttonDisabled]}
            disabled={!loaded}
            onPress={() => {
              if (hasSession(sessionId)) removeSession(sessionId);
              else addSession({ sessionId, backendId, directory });
              onClose();
            }}
          >
            <Text style={styles.modalOptionText}>
              {hasSession(sessionId) ? "Skiaボードから除外" : "Skiaボードへ追加"}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </AppModal>
  );
}
