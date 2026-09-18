import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

export type CommandExecutionRowProps = CodexCommandExecutionInfo;

export function CommandExecutionRow({ command, status, exitCode }: CommandExecutionRowProps) {
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const isRunning = status === "running";
  const isFailed = status === "failed";
  const label = isRunning ? "Running" : "Ran";
  const exitLabel = isFailed && Number.isFinite(Number(exitCode)) ? ` exit ${exitCode}` : "";

  return (
    <View style={styles.root}>
      {isRunning ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} style={styles.spinner} />
      ) : (
        <Text style={[styles.marker, isFailed ? styles.toneFailed : styles.toneDefault]}>⏺</Text>
      )}
      <Text
        style={[styles.text, isFailed ? styles.toneFailed : styles.toneDefault]}
        numberOfLines={2}
        ellipsizeMode="tail"
      >
        <Text style={styles.label}>{label} </Text>
        <Text style={styles.command}>`{command}`</Text>
        {exitLabel ? <Text style={styles.label}>{exitLabel}</Text> : null}
      </Text>
    </View>
  );
}

function createCommandExecutionStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingVertical: 2,
  },
  spinner: {
    width: 14,
    height: 14,
    marginTop: 1,
  },
  marker: {
    fontSize: theme.typography.small.fontSize,
    width: 14,
    textAlign: "center",
  },
  text: {
    flex: 1,
    fontSize: theme.typography.small.fontSize,
    lineHeight: theme.typography.captionRelaxed.lineHeight,
  },
  toneDefault: {
    color: theme.colors.textMuted,
  },
  toneFailed: {
    color: theme.colors.negativeText,
  },
  label: {
    fontWeight: "700",
  },
  command: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  });
}

const stylesByTheme: Record<VisualThemeId, ReturnType<typeof createCommandExecutionStyles>> = {
  standard: createCommandExecutionStyles(VISUAL_THEMES.standard),
  highLegibility: createCommandExecutionStyles(VISUAL_THEMES.highLegibility),
};
