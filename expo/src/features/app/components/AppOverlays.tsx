import { useEffect, useState, type RefObject } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { ApprovalAction } from "../../codex/approvalFlow";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useConversation } from "../contexts/ConversationContext";
import type { ApprovalDialogViewState } from "../hooks/useApprovalRequestController";
import { styles } from "../styles";
import { SlashCommandSelectMenu, type SlashCommandOption } from "./SlashCommandSelectMenu";

const APPROVAL_MODAL_PRESENT_DELAY_MS = 350;

type AppOverlaysProps = {
  composerFullscreenOpen: boolean;
  closeComposerFullscreen: () => void;
  chatComposerFullscreenInputRef: RefObject<TextInput | null>;
  setComposerInputFocused: (focused: boolean) => void;
  slashCommandSelectOpen: boolean;
  setSlashCommandSelectOpen: (open: boolean) => void;
  slashCommandOptions: SlashCommandOption[];
  onSelectSlashCommand: (command: string) => void;
  approvalDialog: ApprovalDialogViewState | null;
  onApprovalDialogAction: (action: ApprovalAction) => void;
};

export function AppOverlays({
  composerFullscreenOpen,
  closeComposerFullscreen,
  chatComposerFullscreenInputRef,
  setComposerInputFocused,
  slashCommandSelectOpen,
  setSlashCommandSelectOpen,
  slashCommandOptions,
  onSelectSlashCommand,
  approvalDialog,
  onApprovalDialogAction,
}: AppOverlaysProps) {
  const approvalDialogPending = !!approvalDialog;
  const [approvalPresentationReady, setApprovalPresentationReady] = useState(false);
  const {
    modelSelectOpen,
    setModelSelectOpen,
    modelOptions,
    modelRef,
    selectModel,
    thinkSelectOpen,
    setThinkSelectOpen,
    thinkOptions,
    reasoningEffort,
    selectThinkOption,
  } = useAppSettings();
  const {
    transcript,
    setTranscript,
    directorySelectOpen,
    setDirectorySelectOpen,
    directoryExplorerPathLabel,
    directoryExplorerHasParent,
    directoryExplorerLoading,
    directoryExplorerError,
    directoryExplorerEntries,
    goDirectoryParent,
    goDirectoryRoot,
    selectCurrentDirectory,
    openDirectoryEntry,
  } = useConversation();
  const formatCompactDirectoryPath = (pathRaw: unknown) => {
    const path = String(pathRaw || "").trim();
    if (!path) return "-";
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length <= 2) return normalized;
    return `.../${segments.slice(-2).join("/")}`;
  };
  const approvalAlertA11y = {
    role: "alertdialog" as const,
    "aria-modal": true,
    "aria-labelledby": "approval-title",
    "aria-describedby": "approval-message",
  };
  useEffect(() => {
    if (!approvalDialogPending) {
      setApprovalPresentationReady(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setApprovalPresentationReady(true);
    }, APPROVAL_MODAL_PRESENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [approvalDialogPending]);
  return (
    <>
      {/* Only an explicit button may resolve an approval request. */}
      <Modal
        visible={!!approvalDialog?.visible && approvalPresentationReady}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => undefined}
      >
        <View
          style={styles.approvalBackdrop}
          role="presentation"
          importantForAccessibility="yes"
        >
          <View
            {...approvalAlertA11y}
            style={styles.approvalModalCard}
            accessibilityViewIsModal
            importantForAccessibility="yes"
            accessible
          >
            <View style={styles.approvalAlertBody}>
              {!!approvalDialog?.sessionContext && (
                <Text style={styles.approvalSessionContextText} numberOfLines={1}>
                  {approvalDialog.sessionContext}
                </Text>
              )}
              <Text nativeID="approval-title" style={styles.approvalModalTitle}>
                {approvalDialog?.title || "このコマンドを実行しますか？"}
              </Text>
              <Text nativeID="approval-message" style={styles.approvalMessageText} numberOfLines={3}>
                {approvalDialog?.message || "この操作には承認が必要です"}
              </Text>
              <Text style={styles.approvalCommandText} numberOfLines={6}>
                {approvalDialog?.commandText || approvalDialog?.commandLabel || "-"}
              </Text>
            </View>
            <View style={styles.approvalActionList}>
              <TouchableOpacity
                style={[styles.approvalAlertButton, styles.approvalAlertButtonPrimary]}
                onPress={() => onApprovalDialogAction("approve_once")}
                accessibilityRole="button"
              >
                <Text style={[styles.approvalAlertButtonText, styles.approvalAlertButtonPrimaryText]}>
                  今回のみ許可
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.approvalAlertButton}
                onPress={() => onApprovalDialogAction("approve_for_session")}
                accessibilityRole="button"
              >
                <Text style={styles.approvalAlertButtonText}>許可して今後確認しない</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.approvalAlertButton}
                onPress={() => onApprovalDialogAction("decline")}
                accessibilityRole="button"
              >
                <Text style={[styles.approvalAlertButtonText, styles.approvalAlertButtonDangerText]}>拒否</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={composerFullscreenOpen && !approvalDialogPending}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={closeComposerFullscreen}
      >
        <SafeAreaView style={styles.chatComposerFullscreenRoot}>
          <KeyboardAvoidingView
            style={styles.chatComposerFullscreenKeyboardAvoiding}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            automaticOffset={Platform.OS === "ios"}
          >
            <View style={styles.chatComposerFullscreenHeader}>
              <Text style={styles.chatComposerFullscreenTitle}>Input Editor</Text>
              <TouchableOpacity
                style={styles.chatComposerFullscreenClose}
                onPress={closeComposerFullscreen}
                accessibilityRole="button"
                accessibilityLabel="全画面入力を閉じる"
              >
                <Ionicons name="contract-outline" size={18} color="#334155" />
              </TouchableOpacity>
            </View>
            <View style={styles.chatComposerFullscreenInputWrap}>
              <TextInput
                ref={chatComposerFullscreenInputRef}
                style={styles.chatComposerFullscreenInput}
                value={transcript}
                onChangeText={setTranscript}
                placeholder="メッセージを入力"
                multiline
                scrollEnabled
                textAlignVertical="top"
                autoCorrect={false}
                autoCapitalize="none"
                onFocus={() => setComposerInputFocused(true)}
                onBlur={() => setComposerInputFocused(false)}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
      <SlashCommandSelectMenu
        visible={slashCommandSelectOpen && !approvalDialogPending}
        options={slashCommandOptions}
        onClose={() => setSlashCommandSelectOpen(false)}
        onSelect={onSelectSlashCommand}
      />
      <Modal visible={modelSelectOpen && !approvalDialogPending} transparent animationType="fade" onRequestClose={() => setModelSelectOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelSelectOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>LLM Model</Text>
            {modelOptions.map((item) => {
              const selected = item.value === modelRef;
              return (
                <TouchableOpacity
                  key={item.value}
                  style={[styles.modalOption, selected && styles.modalOptionSelected]}
                  onPress={() => selectModel(item.value)}
                >
                  <Text style={[styles.modalOptionText, selected && styles.modalOptionTextSelected]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={directorySelectOpen && !approvalDialogPending} transparent animationType="fade" onRequestClose={() => setDirectorySelectOpen(false)}>
        <Pressable style={styles.directoryExplorerBackdrop} onPress={() => setDirectorySelectOpen(false)}>
          <Pressable style={styles.directoryExplorerCard} onPress={() => {}}>
            <View style={styles.directoryExplorerHeader}>
              <View style={styles.directoryExplorerHeaderRow}>
                <TouchableOpacity
                  style={styles.directoryExplorerCloseButton}
                  onPress={() => setDirectorySelectOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="ディレクトリエクスプローラーを閉じる"
                >
                  <Ionicons name="close" size={18} color="#334155" />
                </TouchableOpacity>
              </View>
              <Text style={styles.directoryExplorerCurrentPathText} numberOfLines={2}>
                {formatCompactDirectoryPath(directoryExplorerPathLabel)}
              </Text>
            </View>
            <View style={styles.directoryExplorerListArea}>
              {directoryExplorerError ? <Text style={styles.errorText}>{directoryExplorerError}</Text> : null}
              {directoryExplorerLoading ? (
                <View style={styles.directoryExplorerLoadingRow}>
                  <ActivityIndicator size="small" color="#2563eb" />
                  <Text style={styles.hint}>読み込み中...</Text>
                </View>
              ) : null}
              <ScrollView
                style={styles.directoryExplorerListScroll}
                contentContainerStyle={styles.directoryExplorerListContent}
                keyboardShouldPersistTaps="handled"
              >
                {directoryExplorerEntries.length === 0 ? (
                  <View style={styles.directoryExplorerEmptyState}>
                    <Ionicons name="folder-open-outline" size={16} color="#64748b" />
                    <Text style={styles.hint}>サブディレクトリはありません。</Text>
                  </View>
                ) : (
                  directoryExplorerEntries.map((entry) => (
                    <TouchableOpacity
                      key={entry.path}
                      style={styles.directoryExplorerEntryButton}
                      onPress={() => openDirectoryEntry(entry.path)}
                    >
                      <View style={styles.directoryExplorerEntryMain}>
                        <Ionicons name="folder-outline" size={18} color="#1d4ed8" />
                        <View style={styles.directoryExplorerEntryTextWrap}>
                          <Text style={styles.directoryExplorerEntryName} numberOfLines={1}>
                            {entry.name}
                          </Text>
                        </View>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color="#64748b" />
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
            <View style={styles.directoryExplorerFooter}>
              <View style={styles.directoryExplorerNavRow}>
                <TouchableOpacity
                  style={[
                    styles.directoryExplorerSecondaryButton,
                    (!directoryExplorerHasParent || directoryExplorerLoading) && styles.buttonDisabled,
                  ]}
                  disabled={!directoryExplorerHasParent || directoryExplorerLoading}
                  onPress={goDirectoryParent}
                >
                  <Ionicons name="arrow-up" size={15} color="#1e40af" />
                  <Text style={styles.directoryExplorerSecondaryButtonText}>上の階層</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.directoryExplorerSecondaryButton, directoryExplorerLoading && styles.buttonDisabled]}
                  disabled={directoryExplorerLoading}
                  onPress={goDirectoryRoot}
                >
                  <Ionicons name="home-outline" size={15} color="#1e40af" />
                  <Text style={styles.directoryExplorerSecondaryButtonText}>ルート</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.directoryExplorerPrimaryButton, directoryExplorerLoading && styles.buttonDisabled]}
                disabled={directoryExplorerLoading}
                onPress={selectCurrentDirectory}
              >
                <Ionicons name="add-circle-outline" size={16} color="#1e40af" />
                <Text style={styles.directoryExplorerPrimaryButtonText}>このディレクトリを登録</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={thinkSelectOpen && !approvalDialogPending} transparent animationType="fade" onRequestClose={() => setThinkSelectOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setThinkSelectOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Think</Text>
            {thinkOptions.map((item) => {
              const selected = item === reasoningEffort;
              return (
                <TouchableOpacity
                  key={item}
                  style={[styles.modalOption, selected && styles.modalOptionSelected]}
                  onPress={() => selectThinkOption(item)}
                >
                  <Text style={[styles.modalOptionText, selected && styles.modalOptionTextSelected]}>
                    {item}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
