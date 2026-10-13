import { Text, TouchableOpacity, View } from "react-native";
import { useAppStyles } from "../styles";
import { CircularProgressRing } from "./CircularProgressRing";

type ContextUsageIndicatorProps = {
  contextPctText: string;
  progress: number;
  progressColor: string;
  trackColor: string;
  textColor?: string;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
};

export function ContextUsageIndicator({ contextPctText, progress, progressColor, trackColor,
  textColor, onLongPress, disabled = false, accessibilityHint }: ContextUsageIndicatorProps) {
  const styles = useAppStyles();
  const label = <Text style={[styles.contextUsageText, textColor ? { color: textColor } : null]}>{contextPctText}</Text>;
  return (
    <View style={styles.contextUsageRingWrap}>
      <CircularProgressRing size={36} strokeWidth={3} progress={progress}
        trackColor={trackColor} progressColor={progressColor} />
      {onLongPress ? (
        <TouchableOpacity style={styles.contextUsageLabelWrap} onLongPress={onLongPress}
          disabled={disabled} delayLongPress={450} accessibilityRole="button"
          accessibilityLabel={`コンテキスト使用量 ${contextPctText}`}
          accessibilityHint={accessibilityHint}>
          {label}
        </TouchableOpacity>
      ) : (
        <View style={styles.contextUsageLabelWrap} accessible
          accessibilityLabel={`コンテキスト使用量 ${contextPctText}`}>
          {label}
        </View>
      )}
    </View>
  );
}
