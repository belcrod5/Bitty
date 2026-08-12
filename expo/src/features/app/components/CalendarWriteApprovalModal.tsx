import { Text, TouchableOpacity, View } from "react-native";
import type { CalendarWriteConfirmation } from "../../calendar/calendarToolHandler";
import { AppModal } from "./AppModal";

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
  const value = props.request?.view;
  return (
    <AppModal visible={!!props.request} transparent animationType="fade" onRequestClose={() => props.onDecide(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.45)" }}>
        <View style={{ backgroundColor: "white", borderRadius: 12, padding: 20, gap: 12 }}>
          <Text style={{ fontWeight: "700", fontSize: 18 }}>カレンダーの変更を確認</Text>
          <Text>{String(props.request?.operation || "")}</Text>
          <Text>予定: {value?.title || "予定"}</Text>
          {value?.start ? <Text>開始: {formatCalendarDate(value.start, value.allDay, value.timeZone)}</Text> : null}
          {value?.end ? <Text>終了: {formatCalendarDate(value.end, value.allDay, value.timeZone)}</Text> : null}
          {value?.location ? <Text>場所: {value.location}</Text> : null}
          {value?.notes ? <Text>メモ: {value.notes}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
            <TouchableOpacity onPress={() => props.onDecide(false)}><Text>キャンセル</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => props.onDecide(true)}><Text>実行</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </AppModal>
  );
}
