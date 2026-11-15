import { StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useRegisteredDirectoryActiveSessionCount } from "../hooks/useRegisteredDirectoryActiveSessionCount";
import { useVisualTheme } from "../theme/VisualThemeContext";

export function RunningSessionCount() {
  const count = useRegisteredDirectoryActiveSessionCount();
  const { theme } = useVisualTheme();
  const color = theme.tones.neutral.foreground;

  return (
    <View style={styles.row}>
      <Svg width={13} height={13} viewBox="0 0 11 11" fill="none">
        <Path d="M5.5 1A2.1 2.1 0 1 0 5.5 5.2A2.1 2.1 0 1 0 5.5 1ZM1.2 10.5C1.5 7.7 3 6.4 5.5 6.4S9.5 7.7 9.8 10.5"
          stroke={color} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      <Text style={{ color, fontSize: theme.typography.caption.fontSize, lineHeight: 16, fontWeight: "700" }}
        testID="running-session-count" accessibilityLabel={`実行中のセッション ${count ?? "不明"}件`}>
        {count ?? "--"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
});
