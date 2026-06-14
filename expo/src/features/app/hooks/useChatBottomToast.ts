import { useCallback, useEffect, useRef, useState } from "react";
import { Animated } from "react-native";

export type ChatBottomToast = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type UseChatBottomToastOptions = {
  visibleMs: number;
  trimText: (text: string, maxChars?: number) => string;
  maxChars?: number;
};

export function useChatBottomToast(options: UseChatBottomToastOptions) {
  const {
    visibleMs,
    trimText,
    maxChars = 120,
  } = options;

  const [chatBottomToast, setChatBottomToast] = useState<ChatBottomToast | null>(null);
  const chatBottomToastAnimRef = useRef(new Animated.Value(0));
  const chatBottomToastHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatBottomToastTokenRef = useRef(0);
  const chatLastToastedMessageIdRef = useRef("");
  const chatLastReplyToastAtRef = useRef(0);
  const chatLastReplyToastTextRef = useRef("");

  const showChatBottomToast = useCallback((role: "user" | "assistant", rawText: string) => {
    const text = trimText(String(rawText || "").trim().replace(/\s+/g, " "), maxChars);
    if (!text) return;
    chatBottomToastTokenRef.current += 1;
    const token = chatBottomToastTokenRef.current;
    if (chatBottomToastHideTimerRef.current) {
      clearTimeout(chatBottomToastHideTimerRef.current);
      chatBottomToastHideTimerRef.current = null;
    }
    setChatBottomToast({
      id: `${Date.now()}-${token}`,
      role,
      text,
    });
    chatBottomToastAnimRef.current.stopAnimation();
    chatBottomToastAnimRef.current.setValue(0);
    Animated.timing(chatBottomToastAnimRef.current, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
    chatBottomToastHideTimerRef.current = setTimeout(() => {
      if (chatBottomToastTokenRef.current !== token) return;
      Animated.timing(chatBottomToastAnimRef.current, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        if (chatBottomToastTokenRef.current !== token) return;
        setChatBottomToast(null);
      });
    }, visibleMs);
  }, [maxChars, trimText, visibleMs]);

  const hideChatBottomToast = useCallback(() => {
    if (chatBottomToastHideTimerRef.current) {
      clearTimeout(chatBottomToastHideTimerRef.current);
      chatBottomToastHideTimerRef.current = null;
    }
    chatBottomToastTokenRef.current += 1;
    chatBottomToastAnimRef.current.stopAnimation();
    chatBottomToastAnimRef.current.setValue(0);
    setChatBottomToast(null);
  }, []);

  const markConversationMessageToasted = useCallback((messageIdRaw: unknown) => {
    const messageId = String(messageIdRaw || "").trim();
    if (!messageId) return false;
    if (chatLastToastedMessageIdRef.current === messageId) return false;
    chatLastToastedMessageIdRef.current = messageId;
    return true;
  }, []);

  const shouldShowReplyPreviewToast = useCallback((replyTextRaw: unknown, throttleMs: number) => {
    const nextReply = String(replyTextRaw || "").trim();
    if (!nextReply) return false;
    const now = Date.now();
    if (
      chatLastReplyToastTextRef.current === nextReply &&
      now - chatLastReplyToastAtRef.current < throttleMs
    ) {
      return false;
    }
    if (now - chatLastReplyToastAtRef.current < throttleMs) {
      return false;
    }
    chatLastReplyToastAtRef.current = now;
    chatLastReplyToastTextRef.current = nextReply;
    return true;
  }, []);

  useEffect(() => {
    return () => {
      if (chatBottomToastHideTimerRef.current) {
        clearTimeout(chatBottomToastHideTimerRef.current);
        chatBottomToastHideTimerRef.current = null;
      }
      chatBottomToastAnimRef.current.stopAnimation();
    };
  }, []);

  return {
    chatBottomToast,
    chatBottomToastAnimRef,
    showChatBottomToast,
    hideChatBottomToast,
    markConversationMessageToasted,
    shouldShowReplyPreviewToast,
  };
}
