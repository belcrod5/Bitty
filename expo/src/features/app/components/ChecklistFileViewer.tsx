import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  moveChecklistItem,
  serializeChecklistFile,
  type ChecklistItem,
} from "../utils/checklistFile";
import type { RunnerFileViewerTarget } from "../utils/runnerFileContextMenu";
import type {
  WorkspaceFileWriteResult,
} from "../utils/workspaceFiles";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

const CHECKLIST_ROW_HEIGHT = 68;

type ChecklistViewItem = ChecklistItem & {
  id: number;
};

type ChecklistFileViewerProps = {
  target: RunnerFileViewerTarget;
  initialItems: ChecklistItem[];
  initialVersion: string;
  onSave: (
    target: RunnerFileViewerTarget,
    content: string,
    expectedVersion: string,
  ) => Promise<WorkspaceFileWriteResult>;
  onSavingChange: (saving: boolean) => void;
};

type ChecklistRowProps = {
  item: ChecklistViewItem;
  index: number;
  itemCount: number;
  disabled: boolean;
  editing: boolean;
  editText: string;
  onToggle: () => void;
  onStartEdit: () => void;
  onChangeEditText: (text: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onDrop: (fromIndex: number, toIndex: number) => void;
  onDraggingChange: (dragging: boolean) => void;
};

function ChecklistRow({
  item,
  index,
  itemCount,
  disabled,
  editing,
  editText,
  onToggle,
  onStartEdit,
  onChangeEditText,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onDrop,
  onDraggingChange,
}: ChecklistRowProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const dragY = useRef(new Animated.Value(0)).current;
  const dragGesture = useMemo(() => Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetY([-3, 3])
    .failOffsetX([-12, 12])
    .runOnJS(true)
    .onBegin(() => {
      onDraggingChange(true);
    })
    .onUpdate((event) => {
      dragY.setValue(event.translationY);
    })
    .onEnd((event) => {
      const offset = Math.round(event.translationY / CHECKLIST_ROW_HEIGHT);
      const toIndex = Math.max(0, Math.min(itemCount - 1, index + offset));
      dragY.setValue(0);
      onDraggingChange(false);
      if (toIndex !== index) onDrop(index, toIndex);
    })
    .onFinalize(() => {
      dragY.setValue(0);
      onDraggingChange(false);
    }), [disabled, dragY, index, itemCount, onDraggingChange, onDrop]);

  return (
    <Animated.View
      style={[
        styles.row,
        { transform: [{ translateY: dragY }] },
      ]}
      testID={`checklist-row-${index}`}
    >
      <TouchableOpacity
        style={styles.checkboxButton}
        onPress={onToggle}
        disabled={disabled || editing}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.checked, disabled: disabled || editing }}
        accessibilityLabel={`${item.text}を${item.checked ? "未完了" : "完了"}にする`}
        testID={`checklist-toggle-${index}`}
      >
        <Ionicons
          name={item.checked ? "checkbox" : "square-outline"}
          size={30}
          color={item.checked ? theme.colors.textPrimary : theme.colors.textMuted}
        />
      </TouchableOpacity>

      {editing ? (
        <View style={styles.editArea}>
          <TextInput
            style={styles.editInput}
            value={editText}
            onChangeText={onChangeEditText}
            onSubmitEditing={onCommitEdit}
            editable={!disabled}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            testID={`checklist-edit-input-${index}`}
          />
          <TouchableOpacity
            style={styles.inlineButton}
            onPress={onCommitEdit}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="項目の修正を確定"
          >
            <Ionicons name="checkmark" size={22} color={theme.colors.successText} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.inlineButton}
            onPress={onCancelEdit}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="項目の修正をキャンセル"
          >
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.itemTextButton}
          onPress={onStartEdit}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${item.text}を修正`}
          testID={`checklist-text-${index}`}
        >
          <Text
            style={[styles.itemText, item.checked ? styles.checkedItemText : null]}
            numberOfLines={2}
          >
            {item.text}
          </Text>
        </TouchableOpacity>
      )}

      {!editing ? (
        <>
          <GestureDetector gesture={dragGesture}>
            <View
              style={[styles.iconButton, disabled ? styles.disabled : null]}
              accessibilityRole="adjustable"
              accessibilityLabel={`${item.text}を並べ替え`}
              accessibilityState={{ disabled }}
              accessibilityActions={[
                { name: "decrement", label: "上へ移動" },
                { name: "increment", label: "下へ移動" },
              ]}
              onAccessibilityAction={(event) => {
                if (disabled) return;
                const actionName = event.nativeEvent.actionName;
                if (actionName !== "increment" && actionName !== "decrement") return;
                const offset = actionName === "increment" ? 1 : -1;
                const toIndex = Math.max(0, Math.min(itemCount - 1, index + offset));
                if (toIndex !== index) onDrop(index, toIndex);
              }}
              testID={`checklist-drag-${index}`}
            >
              <Ionicons name="reorder-three" size={28} color={theme.colors.textMuted} />
            </View>
          </GestureDetector>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={onDelete}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${item.text}を削除`}
            testID={`checklist-delete-${index}`}
          >
            <Ionicons name="trash-outline" size={23} color={theme.colors.negativeText} />
          </TouchableOpacity>
        </>
      ) : null}
    </Animated.View>
  );
}

export function ChecklistFileViewer({
  target,
  initialItems,
  initialVersion,
  onSave,
  onSavingChange,
}: ChecklistFileViewerProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const nextIdRef = useRef(1);
  const savingRef = useRef(false);
  const versionRef = useRef(initialVersion);
  const itemsRef = useRef<ChecklistViewItem[]>([]);
  const [items, setItems] = useState<ChecklistViewItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editText, setEditText] = useState("");
  const [newItemText, setNewItemText] = useState("");

  useEffect(() => {
    nextIdRef.current = initialItems.length + 1;
    versionRef.current = initialVersion;
    const nextItems = initialItems.map((item, index) => ({ ...item, id: index + 1 }));
    itemsRef.current = nextItems;
    setItems(nextItems);
    setEditingId(null);
    setDragging(false);
    setEditText("");
    setNewItemText("");
    savingRef.current = false;
    setSaving(false);
    onSavingChange(false);
  }, [initialItems, initialVersion, onSavingChange, target.path]);

  const saveItems = useCallback(async (nextItems: ChecklistViewItem[]) => {
    if (savingRef.current) return false;
    const previousItems = itemsRef.current;
    savingRef.current = true;
    onSavingChange(true);
    itemsRef.current = nextItems;
    setItems(nextItems);
    setSaving(true);
    try {
      const result = await onSave(
        target,
        serializeChecklistFile(nextItems),
        versionRef.current,
      );
      versionRef.current = result.version;
      return true;
    } catch {
      itemsRef.current = previousItems;
      setItems(previousItems);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  }, [onSave, onSavingChange, target]);

  const interactionDisabled = saving || editingId !== null;
  const checkedCount = items.filter((item) => item.checked).length;

  const toggleItem = useCallback((index: number) => {
    if (interactionDisabled) return;
    const nextItems = items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, checked: !item.checked } : item
    ));
    void saveItems(nextItems);
  }, [interactionDisabled, items, saveItems]);

  const deleteItem = useCallback((index: number) => {
    if (interactionDisabled) return;
    const item = items[index];
    if (!item) return;
    Alert.alert(
      "項目を削除しますか？",
      item.text,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: () => {
            void saveItems(items.filter((_item, itemIndex) => itemIndex !== index));
          },
        },
      ],
    );
  }, [interactionDisabled, items, saveItems]);

  const startEdit = useCallback((item: ChecklistViewItem) => {
    if (interactionDisabled) return;
    setEditingId(item.id);
    setEditText(item.text);
  }, [interactionDisabled]);

  const commitEdit = useCallback(() => {
    if (saving || editingId === null) return;
    const text = editText.trim();
    if (!text) {
      Alert.alert("入力を確認してください", "項目の内容を入力してください。");
      return;
    }
    const currentItem = items.find((item) => item.id === editingId);
    if (!currentItem || currentItem.text === text) {
      setEditingId(null);
      setEditText("");
      return;
    }
    const nextItems = items.map((item) => (
      item.id === editingId ? { ...item, text } : item
    ));
    void saveItems(nextItems).then((saved) => {
      if (saved) {
        setEditingId(null);
        setEditText("");
      }
    });
  }, [editText, editingId, items, saveItems, saving]);

  const addItems = useCallback(() => {
    if (interactionDisabled) return;
    const texts = newItemText
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean);
    if (texts.length === 0) return;
    const addedItems = texts.map((text) => ({
      id: nextIdRef.current++,
      checked: false,
      text,
    }));
    void saveItems([...items, ...addedItems]).then((saved) => {
      if (saved) setNewItemText("");
    });
  }, [interactionDisabled, items, newItemText, saveItems]);

  const dropItem = useCallback((fromIndex: number, toIndex: number) => {
    if (interactionDisabled) return;
    const nextItems = moveChecklistItem(items, fromIndex, toIndex);
    if (nextItems !== items) void saveItems(nextItems);
  }, [interactionDisabled, items, saveItems]);

  const deleteChecked = useCallback(() => {
    if (interactionDisabled || checkedCount === 0) return;
    Alert.alert(
      "チェック済みを削除しますか？",
      `${checkedCount}件の項目を削除します。`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: () => {
            void saveItems(items.filter((item) => !item.checked));
          },
        },
      ],
    );
  }, [checkedCount, interactionDisabled, items, saveItems]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={64}
    >
      <View style={styles.actionBar}>
        <Text style={styles.summary}>{items.length}件</Text>
        {saving ? (
          <View style={styles.savingStatus}>
            <ActivityIndicator size="small" color={theme.colors.textMuted} />
            <Text style={styles.savingText}>保存中</Text>
          </View>
        ) : (
          <Text style={styles.savedText}>保存済み</Text>
        )}
        <TouchableOpacity
          style={[
            styles.deleteCheckedButton,
            (checkedCount === 0 || interactionDisabled) ? styles.disabled : null,
          ]}
          onPress={deleteChecked}
          disabled={checkedCount === 0 || interactionDisabled}
          accessibilityRole="button"
          accessibilityLabel="チェック済みをまとめて削除"
          testID="checklist-delete-checked"
        >
          <Ionicons name="trash-outline" size={17} color={theme.colors.negativeText} />
          <Text style={styles.deleteCheckedText}>チェック済みを削除</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        testID="checklist-list"
        style={styles.list}
        contentContainerStyle={items.length === 0 ? styles.emptyList : styles.listContent}
        data={items}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!saving && !dragging}
        renderItem={({ item, index }) => (
          <ChecklistRow
            item={item}
            index={index}
            itemCount={items.length}
            disabled={saving || (editingId !== null && editingId !== item.id)}
            editing={editingId === item.id}
            editText={editText}
            onToggle={() => toggleItem(index)}
            onStartEdit={() => startEdit(item)}
            onChangeEditText={setEditText}
            onCommitEdit={commitEdit}
            onCancelEdit={() => {
              setEditingId(null);
              setEditText("");
            }}
            onDelete={() => deleteItem(index)}
            onDrop={dropItem}
            onDraggingChange={setDragging}
          />
        )}
        ListEmptyComponent={(
          <View style={styles.emptyArea}>
            <Ionicons name="checkmark-circle-outline" size={42} color={theme.colors.borderStrong} />
            <Text style={styles.emptyText}>項目はありません</Text>
          </View>
        )}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.newItemInput}
          value={newItemText}
          onChangeText={setNewItemText}
          editable={!interactionDisabled}
          placeholder="項目を入力（改行で複数行）"
          placeholderTextColor={theme.colors.borderStrong}
          multiline
          textAlignVertical="top"
          testID="checklist-new-item-input"
        />
        <TouchableOpacity
          style={[
            styles.addButton,
            (!newItemText.trim() || interactionDisabled) ? styles.disabled : null,
          ]}
          onPress={addItems}
          disabled={!newItemText.trim() || interactionDisabled}
          accessibilityRole="button"
          accessibilityLabel="項目を追加"
          testID="checklist-add"
        >
          <Ionicons name="add" size={27} color={theme.colors.textOnAccent} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function createChecklistStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surfaceRaised,
  },
  actionBar: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderBottomWidth: theme.borders.divider,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  summary: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.compact.fontSize,
    fontWeight: "700",
  },
  savingStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  savingText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.small.fontSize,
  },
  savedText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.small.fontSize,
  },
  deleteCheckedButton: {
    marginLeft: "auto",
    minHeight: 36,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  deleteCheckedText: {
    color: theme.colors.negativeText,
    fontSize: theme.typography.compact.fontSize,
    fontWeight: "700",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  emptyList: {
    flexGrow: 1,
    padding: 24,
  },
  emptyArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.body.fontSize,
  },
  row: {
    height: CHECKLIST_ROW_HEIGHT,
    paddingHorizontal: 5,
    borderBottomWidth: theme.borders.divider,
    borderBottomColor: theme.colors.borderSubtle,
    backgroundColor: theme.colors.surfaceRaised,
    flexDirection: "row",
    alignItems: "center",
  },
  checkboxButton: {
    width: 46,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  itemTextButton: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    justifyContent: "center",
  },
  itemText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.control.fontSize,
    lineHeight: theme.typography.control.lineHeight,
  },
  checkedItemText: {
    color: theme.colors.borderStrong,
    textDecorationLine: "line-through",
  },
  editArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  editInput: {
    flex: 1,
    minWidth: 0,
    height: 42,
    paddingHorizontal: 10,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.borderStrong,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.control.fontSize,
  },
  inlineButton: {
    width: 36,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButton: {
    width: 42,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: {
    opacity: 0.35,
  },
  composer: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: theme.borders.thin,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 8,
  },
  newItemInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 100,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    borderRadius: 9,
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.input.fontSize,
  },
  addButton: {
    width: 48,
    minHeight: 46,
    borderRadius: 9,
    backgroundColor: theme.colors.textPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  });
}

const stylesByTheme = createStylesByTheme(createChecklistStyles);
