import type { IOSNativeProps } from "@react-native-community/datetimepicker";
import { requireNativeComponent, type NativeSyntheticEvent, type ViewProps } from "react-native";

type Props = Pick<IOSNativeProps, "value" | "onChange" | "accessibilityLabel"> & {
  mode: "date" | "time";
  display?: "compact";
  minuteInterval?: 1;
};

const NativeDateTimePicker = requireNativeComponent<ViewProps & {
  timestamp: number;
  mode: Props["mode"];
  onChange: (event: NativeSyntheticEvent<{ timestamp: number }>) => void;
}>("BittyDateTimePicker");

export default function DateTimePicker({ value, mode, accessibilityLabel, onChange }: Props) {
  return <NativeDateTimePicker
    accessibilityLabel={accessibilityLabel}
    timestamp={value.getTime()}
    mode={mode}
    style={{ height: 32, width: "100%", maxWidth: 220 }}
    onChange={({ nativeEvent: { timestamp } }) => {
      const selected = new Date(timestamp);
      onChange?.({ type: "set", nativeEvent: { timestamp, utcOffset: -selected.getTimezoneOffset() } }, selected);
    }}
  />;
}
