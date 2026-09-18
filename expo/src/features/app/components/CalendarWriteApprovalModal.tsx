import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { CalendarWriteConfirmation } from "../../calendar/calendarToolHandler";
import { AppModal } from "./AppModal";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

function formatCalendarDate(value: string, allDay: boolean, timeZone: string | null) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }),
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat("ja-JP", options).format(date);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat("ja-JP", options).format(date);
  }
}

export function CalendarWriteApprovalModal(props: {
  request: CalendarWriteConfirmation | null;
  onDecide: (accepted: boolean) => void;
}) {
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const value = props.request?.view;
  return (
    <AppModal visible={!!props.request} transparent animationType="fade" onRequestClose={() => props.onDecide(false)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>カレンダーの変更を確認</Text>
          <Text style={styles.body}>{String(props.request?.operation || "")}</Text>
          <Text style={styles.body}>予定: {value?.title || "予定"}</Text>
          {value?.start ? <Text style={styles.body}>開始: {formatCalendarDate(value.start, value.allDay, value.timeZone)}</Text> : null}
          {value?.end ? <Text style={styles.body}>終了: {formatCalendarDate(value.end, value.allDay, value.timeZone)}</Text> : null}
          {value?.location ? <Text style={styles.body}>場所: {value.location}</Text> : null}
          {value?.notes ? <Text style={styles.body}>メモ: {value.notes}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity onPress={() => props.onDecide(false)}><Text style={styles.action}>キャンセル</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => props.onDecide(true)}><Text style={styles.action}>実行</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </AppModal>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: "center",
      padding: 24,
      backgroundColor: theme.approval.backdrop,
    },
    card: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      borderWidth: theme.approval.borderWidth,
      borderColor: theme.colors.borderStrong,
      padding: 20,
      gap: 12,
    },
    title: {
      color: theme.colors.textPrimary,
      fontSize: theme.typography.title.fontSize,
      lineHeight: theme.typography.title.lineHeight,
      fontWeight: "700",
    },
    body: {
      color: theme.colors.textPrimary,
      fontSize: theme.typography.body.fontSize,
      lineHeight: theme.typography.body.lineHeight,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 12,
    },
    action: {
      color: theme.colors.controlAccent,
      fontSize: theme.typography.body.fontSize,
      lineHeight: theme.typography.body.lineHeight,
      fontWeight: "700",
    },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
