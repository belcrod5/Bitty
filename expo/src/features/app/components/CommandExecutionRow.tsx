import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";

export type CommandExecutionRowProps = CodexCommandExecutionInfo;

export function CommandExecutionRow({ command, status, exitCode }: CommandExecutionRowProps) {
  const isRunning = status === "running";
  const isFailed = status === "failed";
  const label = isRunning ? "Running" : "Ran";
  const exitLabel = isFailed && Number.isFinite(Number(exitCode)) ? ` exit ${exitCode}` : "";

  return (
    <View style={styles.root}>
      {isRunning ? (
        <ActivityIndicator size="small" color="#64748b" style={styles.spinner} />
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

const styles = StyleSheet.create({
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
    fontSize: 12,
    width: 14,
    textAlign: "center",
  },
  text: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  toneDefault: {
    color: "#64748b",
  },
  toneFailed: {
    color: "#dc2626",
  },
  label: {
    fontWeight: "700",
  },
  command: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
});
