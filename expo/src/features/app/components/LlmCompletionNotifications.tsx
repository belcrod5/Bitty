import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  PanResponder,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRunnerWs } from "../../runnerWs/RunnerWsProvider";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { styles } from "../styles";

const LLM_COMPLETION_NOTIFICATION_MAX = 3;
const LLM_COMPLETION_NOTIFICATION_COLLAPSE_DELAY_MS = 5_000;
const LLM_COMPLETION_NOTIFICATION_EDGE_GAP = 10;
const LLM_COMPLETION_NOTIFICATION_COMPACT_SIZE = 48;
const LLM_COMPLETION_NOTIFICATION_EXPANDED_WIDTH = 300;

type LlmCompletionNotification = {
  id: string;
  sessionId: string;
  threadId: string;
  directoryName: string;
  previewText: string;
  completedAt: string;
};

type LlmCompletionNotificationsProps = {
  visibleSessionIds: string[];
  resolveDirectoryName: (sessionId: string) => string;
  onOpenSession: (sessionId: string) => void;
};

type NotificationPosition = {
  right: number;
  top: number;
};

type NotificationViewport = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function parseCompletionNotification(message: RunnerWsMessage): LlmCompletionNotification | null {
  const payload = message.payload && typeof message.payload === "object"
    ? message.payload as Record<string, unknown>
    : {};
  const threadId = String(message.threadId || payload.threadId || "").trim();
  const sessionId = String(message.sessionId || payload.sessionId || threadId).trim();
  const previewText = String(payload.previewText || "").replace(/\s+/g, " ").trim();
  const completedAt = String(payload.completedAt || "").trim();
  if (!sessionId || !threadId || !previewText) return null;
  return {
    id: `${sessionId}:${completedAt || Date.now().toString(36)}`,
    sessionId,
    threadId,
    directoryName: "",
    previewText,
    completedAt,
  };
}

function LlmCompletionNotificationCard({
  notification,
  onOpen,
  onDismiss,
}: {
  notification: LlmCompletionNotification;
  onOpen: (sessionId: string) => void;
  onDismiss: (id: string) => void;
}) {
  const opacityRef = useRef(new Animated.Value(0));
  const translateYRef = useRef(new Animated.Value(-8));
  const scaleRef = useRef(new Animated.Value(0.98));

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacityRef.current, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(translateYRef.current, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(scaleRef.current, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View
      style={[
        styles.llmCompletionNotificationCardMotion,
        {
          opacity: opacityRef.current,
          transform: [
            { translateY: translateYRef.current },
            { scale: scaleRef.current },
          ],
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.88}
        style={styles.llmCompletionNotificationCard}
        onPress={() => {
          onDismiss(notification.id);
          onOpen(notification.sessionId);
        }}
        accessibilityRole="button"
        accessibilityLabel="完了した LLM セッションを開く"
      >
        <TouchableOpacity
          style={styles.llmCompletionNotificationClose}
          onPress={(event) => {
            event.stopPropagation();
            onDismiss(notification.id);
          }}
          accessibilityRole="button"
          accessibilityLabel="通知を閉じる"
        >
          <Ionicons name="close" size={14} color="#64748b" />
        </TouchableOpacity>
        {notification.directoryName ? (
          <Text style={styles.llmCompletionNotificationDirectory} numberOfLines={1}>
            {notification.directoryName}
          </Text>
        ) : null}
        <Text style={styles.llmCompletionNotificationPreview} numberOfLines={3}>
          {notification.previewText}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function LlmCompletionNotifications({
  visibleSessionIds,
  resolveDirectoryName,
  onOpenSession,
}: LlmCompletionNotificationsProps) {
  const runnerWs = useRunnerWs();
  const visibleSessionIdsRef = useRef(new Set<string>());
  const [notifications, setNotifications] = useState<LlmCompletionNotification[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [viewport, setViewport] = useState<NotificationViewport>({ width: 0, height: 0 });
  const [position, setPosition] = useState<NotificationPosition>({
    right: LLM_COMPLETION_NOTIFICATION_EDGE_GAP,
    top: LLM_COMPLETION_NOTIFICATION_EDGE_GAP,
  });
  const positionRef = useRef(position);
  const viewportRef = useRef(viewport);
  const widgetWidthRef = useRef(LLM_COMPLETION_NOTIFICATION_EXPANDED_WIDTH);
  const widgetHeightRef = useRef(0);
  const dragStartPositionRef = useRef(position);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expandedWidth = Math.min(
    LLM_COMPLETION_NOTIFICATION_EXPANDED_WIDTH,
    Math.max(0, viewport.width - LLM_COMPLETION_NOTIFICATION_EDGE_GAP * 2)
  );
  widgetWidthRef.current = expanded
    ? expandedWidth
    : LLM_COMPLETION_NOTIFICATION_COMPACT_SIZE;

  const updatePosition = useCallback((nextPosition: NotificationPosition) => {
    const currentViewport = viewportRef.current;
    const next = {
      right: clamp(
        nextPosition.right,
        LLM_COMPLETION_NOTIFICATION_EDGE_GAP,
        currentViewport.width - widgetWidthRef.current - LLM_COMPLETION_NOTIFICATION_EDGE_GAP
      ),
      top: clamp(
        nextPosition.top,
        LLM_COMPLETION_NOTIFICATION_EDGE_GAP,
        currentViewport.height - widgetHeightRef.current - LLM_COMPLETION_NOTIFICATION_EDGE_GAP
      ),
    };
    positionRef.current = next;
    setPosition(next);
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (!collapseTimerRef.current) return;
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer();
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      setExpanded(false);
    }, LLM_COMPLETION_NOTIFICATION_COLLAPSE_DELAY_MS);
  }, [clearCollapseTimer]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) => (
      Math.abs(gestureState.dx) > 4 || Math.abs(gestureState.dy) > 4
    ),
    onPanResponderGrant: () => {
      dragStartPositionRef.current = positionRef.current;
    },
    onPanResponderMove: (_event, gestureState) => {
      updatePosition({
        right: dragStartPositionRef.current.right - gestureState.dx,
        top: dragStartPositionRef.current.top + gestureState.dy,
      });
    },
    onPanResponderTerminationRequest: () => true,
  }), [updatePosition]);

  useEffect(() => {
    visibleSessionIdsRef.current = new Set(
      visibleSessionIds.map((item) => String(item || "").trim()).filter(Boolean)
    );
  }, [visibleSessionIds]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => clearCollapseTimer, [clearCollapseTimer]);

  useEffect(() => {
    updatePosition(positionRef.current);
  }, [expanded, expandedWidth, updatePosition]);

  useEffect(() => {
    return runnerWs.subscribe({ channel: "llm", op: "turn_completed_notification" }, (message) => {
      const notification = parseCompletionNotification(message);
      if (!notification) return;
      if (visibleSessionIdsRef.current.has(notification.sessionId)) return;
      const nextNotification = {
        ...notification,
        directoryName: resolveDirectoryName(notification.sessionId),
      };
      setNotifications((prev) => {
        const next = prev.filter((item) => (
          item.id !== nextNotification.id && item.sessionId !== nextNotification.sessionId
        ));
        return [nextNotification, ...next].slice(0, LLM_COMPLETION_NOTIFICATION_MAX);
      });
      setExpanded(true);
      scheduleCollapse();
    });
  }, [resolveDirectoryName, runnerWs, scheduleCollapse]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextViewport = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    };
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    updatePosition(positionRef.current);
  }, [updatePosition]);

  const handleWidgetLayout = useCallback((event: LayoutChangeEvent) => {
    widgetHeightRef.current = event.nativeEvent.layout.height;
    updatePosition(positionRef.current);
  }, [updatePosition]);

  const expandNotifications = useCallback(() => {
    setExpanded(true);
    scheduleCollapse();
  }, [scheduleCollapse]);

  return (
    <View
      pointerEvents="box-none"
      style={styles.llmCompletionNotificationHost}
      onLayout={handleViewportLayout}
    >
      {notifications.length > 0 ? (
        <View
          style={[
            styles.llmCompletionNotificationWidget,
            {
              right: position.right,
              top: position.top,
              width: expanded ? expandedWidth : LLM_COMPLETION_NOTIFICATION_COMPACT_SIZE,
            },
          ]}
          onLayout={handleWidgetLayout}
          {...panResponder.panHandlers}
        >
          {expanded ? (
            <View pointerEvents="box-none" style={styles.llmCompletionNotificationStack}>
              {notifications.map((notification) => (
                <LlmCompletionNotificationCard
                  key={notification.id}
                  notification={notification}
                  onOpen={onOpenSession}
                  onDismiss={dismissNotification}
                />
              ))}
            </View>
          ) : (
            <TouchableOpacity
              activeOpacity={0.86}
              style={styles.llmCompletionNotificationCompact}
              onPress={expandNotifications}
              accessibilityRole="button"
              accessibilityLabel={`完了通知 ${notifications.length}件を表示`}
            >
              <Ionicons name="notifications-outline" size={22} color="#0f766e" />
              <View style={styles.llmCompletionNotificationCountBadge}>
                <Text style={styles.llmCompletionNotificationCountText}>
                  {notifications.length}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </View>
  );
}
