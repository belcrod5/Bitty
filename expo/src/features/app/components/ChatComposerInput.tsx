import { useEffect, useRef, type RefObject } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  Platform,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputEndEditingEventData,
  type TextInputSubmitEditingEventData,
} from "react-native";
import { styles } from "../styles";

export const MACOS_CHAT_SUBMIT_KEY_EVENTS = [{ key: "Enter", metaKey: true }];

type ChatComposerInputProps = {
  inputRef: RefObject<TextInput | null>;
  value: string;
  showFullscreenButton: boolean;
  onChangeText: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onSubmit: (value: string, onAccepted: () => void) => Promise<void>;
  submitRequestId: number;
  onOpenFullscreen: () => void;
};

export function ChatComposerInput({
  inputRef,
  value,
  showFullscreenButton,
  onChangeText,
  onFocus,
  onBlur,
  onSubmit,
  submitRequestId,
  onOpenFullscreen,
}: ChatComposerInputProps) {
  const latestValueRef = useRef(value);
  const focusedRef = useRef(false);
  const pendingSubmitRef = useRef(false);
  const handledSubmitRequestIdRef = useRef(submitRequestId);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (handledSubmitRequestIdRef.current === submitRequestId) return;
    handledSubmitRequestIdRef.current = submitRequestId;
    if (Platform.OS === "macos" && focusedRef.current) {
      pendingSubmitRef.current = true;
      inputRef.current?.blur();
      return;
    }
    submit(latestValueRef.current);
  }, [inputRef, onSubmit, submitRequestId]);

  const changeText = (next: string) => {
    latestValueRef.current = next;
    onChangeText(next);
  };

  const submit = (
    valueOrEvent?: string | NativeSyntheticEvent<TextInputSubmitEditingEventData>
  ) => {
    const submittedValue = typeof valueOrEvent === "string"
      ? valueOrEvent
      : valueOrEvent?.nativeEvent.text ?? value;
    if (submittedValue !== latestValueRef.current) changeText(submittedValue);
    void onSubmit(submittedValue, () => {
      if (latestValueRef.current === submittedValue) changeText("");
    });
  };

  return (
    <View style={styles.chatComposerInputArea}>
      <TextInput
        testID="chat-composer-input"
        ref={inputRef}
        style={[
          styles.chatInput,
          styles.chatComposerInput,
          showFullscreenButton ? styles.chatComposerInputWithExpandButton : null,
        ]}
        value={value}
        onChangeText={changeText}
        onSubmitEditing={Platform.OS === "macos" ? submit : undefined}
        {...(Platform.OS === "macos" ? { submitKeyEvents: MACOS_CHAT_SUBMIT_KEY_EVENTS } : {})}
        placeholder="メッセージを入力"
        multiline
        textAlignVertical="top"
        onFocus={() => {
          focusedRef.current = true;
          onFocus();
        }}
        onBlur={() => {
          focusedRef.current = false;
          onBlur();
        }}
        onEndEditing={(event: NativeSyntheticEvent<TextInputEndEditingEventData>) => {
          focusedRef.current = false;
          changeText(event.nativeEvent.text);
          if (!pendingSubmitRef.current) return;
          pendingSubmitRef.current = false;
          submit(event.nativeEvent.text);
        }}
      />
      {showFullscreenButton ? (
        <TouchableOpacity
          style={styles.chatComposerExpandButton}
          onPress={onOpenFullscreen}
          accessibilityRole="button"
          accessibilityLabel="入力欄を全画面表示"
        >
          <Ionicons name="expand-outline" size={16} color="#334155" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
