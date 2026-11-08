import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { setStringAsync } from "../clipboard";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAppShell } from "../contexts/AppShellContext";
import { useComputerBrowser } from "../hooks/useComputerBrowser";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

function modifiedDate(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
}

export function ComputerScreen() {
  const { runnerUrl, runnerToken } = useAppSettings();
  const { openSkiaBoardScreen, openDrawer } = useAppShell();
  const { theme } = useVisualTheme();
  const styles = stylesByTheme[theme.id];
  const { computer, directory, loading, error, browse } = useComputerBrowser(runnerUrl, runnerToken);
  const [showInfo, setShowInfo] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const copySequence = useRef(0);
  useEffect(() => {
    setCopyStatus("");
    return () => { ++copySequence.current; };
  }, [runnerUrl, runnerToken]);

  const copyPath = async (path: string) => {
    const sequence = ++copySequence.current;
    try {
      await setStringAsync(path);
      if (sequence === copySequence.current) setCopyStatus(`コピーしました: ${path}`);
    } catch {
      if (sequence === copySequence.current) setCopyStatus("パスをコピーできませんでした。");
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => { openSkiaBoardScreen(); openDrawer(); }}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="メニューに戻る"
        >
          <Ionicons name="chevron-back" size={21} color={theme.colors.controlAccent} />
          <Text style={styles.actionText}>メニュー</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setShowInfo((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel="コンピューター情報を表示"
          accessibilityState={{ expanded: showInfo }}
        >
          <Ionicons name="information-circle-outline" size={23} color={theme.colors.controlAccent} />
        </TouchableOpacity>
      </View>
      <View style={styles.titleRow}>
        <Ionicons name="desktop-outline" size={32} color={theme.colors.textPrimary} />
        <View style={styles.flex}>
          <Text style={styles.title}>コンピューター</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{computer?.hostname || "接続先のファイル"}</Text>
        </View>
        <Text style={styles.readOnly}>読み取り専用</Text>
      </View>
      {showInfo && computer ? (
        <View style={styles.info}>
          <Text style={styles.infoText}>{computer.operatingSystem} · {computer.architecture}</Text>
          <Text style={styles.infoText}>メモリ {Math.round(computer.totalMemory / 1024 ** 3)} GB</Text>
          <Text style={styles.subtitle}>ホーム: {computer.homePath}</Text>
        </View>
      ) : null}
      <View style={styles.toolbar}>
        <TouchableOpacity style={styles.button} disabled={loading || !directory?.parentPath}
          accessibilityRole="button" accessibilityLabel="上のフォルダーへ"
          accessibilityState={{ disabled: loading || !directory?.parentPath }}
          onPress={() => void browse(directory?.parentPath)}>
          <Ionicons name="chevron-up" size={22} color={loading || !directory?.parentPath ? theme.colors.textMuted : theme.colors.controlAccent} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} disabled={loading || !computer}
          accessibilityRole="button" accessibilityLabel="ホームフォルダーを開く"
          accessibilityState={{ disabled: loading || !computer }}
          onPress={() => void browse(computer?.homePath)}>
          <Ionicons name="home-outline" size={21} color={theme.colors.controlAccent} />
        </TouchableOpacity>
        <Text style={styles.toolbarTitle}>ファイル</Text>
        <TouchableOpacity style={styles.button} disabled={loading}
          accessibilityRole="button" accessibilityLabel="ファイル一覧を更新"
          accessibilityState={{ disabled: loading }}
          onPress={() => void browse(directory?.basePath)}>
          <Ionicons name="refresh-outline" size={21} color={theme.colors.controlAccent} />
        </TouchableOpacity>
      </View>
      {directory ? (
        <View style={styles.pathRow}>
          <Text style={styles.path} numberOfLines={2}>{directory.basePath}</Text>
          <TouchableOpacity style={styles.button} onPress={() => void copyPath(directory.basePath)}
            accessibilityRole="button" accessibilityLabel="現在のフォルダーのパスをコピー">
            <Ionicons name="copy-outline" size={20} color={theme.colors.controlAccent} />
          </TouchableOpacity>
        </View>
      ) : null}
      {copyStatus ? <Text style={styles.status} accessibilityLiveRegion="polite">{copyStatus}</Text> : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {loading ? <ActivityIndicator style={styles.loading} color={theme.colors.controlAccent} accessibilityLabel="ファイルを読み込み中" /> : null}
      <View style={styles.columnHeader}>
        <Text style={[styles.subtitle, styles.flex]}>名前</Text>
        <Text style={[styles.subtitle, styles.date]}>更新日</Text>
        <View style={styles.copyColumn} />
      </View>
      <FlatList
        data={directory?.entries ?? []}
        keyExtractor={(entry) => entry.path}
        style={styles.flex}
        ListEmptyComponent={!loading && !error ? <Text style={styles.empty}>フォルダーは空です</Text> : null}
        ListFooterComponent={directory?.truncated ? <Text style={styles.status}>件数が多いため、一部の項目を表示しています。</Text> : null}
        renderItem={({ item, index }) => (
          <View style={[styles.row, index % 2 === 1 && styles.alternateRow]}>
            <TouchableOpacity style={styles.nameCell} disabled={loading}
              accessibilityRole="button"
              accessibilityLabel={item.kind === "dir" ? `${item.name}フォルダーを開く` : `ファイルのパスをコピー: ${item.name}`}
              accessibilityState={{ disabled: loading }}
              onPress={() => item.kind === "dir" ? void browse(item.path) : void copyPath(item.path)}>
              <Ionicons name={item.kind === "dir" ? "folder" : "document-outline"} size={20}
                color={item.kind === "dir" ? theme.colors.controlAccent : theme.colors.textMuted} />
              <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
            </TouchableOpacity>
            <Text style={styles.date} numberOfLines={2}>{modifiedDate(item.modifiedAt)}</Text>
            <TouchableOpacity style={[styles.button, styles.copyColumn]} onPress={() => void copyPath(item.path)}
              accessibilityRole="button" accessibilityLabel={`${item.name}のパスをコピー`}>
              <Ionicons name="copy-outline" size={18} color={theme.colors.controlAccent} />
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const stylesByTheme = createStylesByTheme((theme: VisualTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surface },
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10 },
  button: { minWidth: 44, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { fontSize: 15, color: theme.colors.controlAccent },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 14 },
  title: { fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary },
  subtitle: { fontSize: 12, color: theme.colors.textMuted },
  readOnly: { fontSize: 11, color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceMuted, borderRadius: 5, padding: 6 },
  info: { marginHorizontal: 18, marginBottom: 12, padding: 12, gap: 5, backgroundColor: theme.colors.surfaceMuted, borderRadius: 10 },
  infoText: { fontSize: 14, color: theme.colors.textPrimary },
  toolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted },
  toolbarTitle: { flex: 1, textAlign: "center", fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary },
  pathRow: { flexDirection: "row", alignItems: "center", paddingLeft: 14, paddingRight: 6 },
  path: { flex: 1, fontSize: 12, color: theme.colors.textSecondary },
  columnHeader: { flexDirection: "row", alignItems: "center", minHeight: 30, paddingLeft: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  row: { flexDirection: "row", alignItems: "center", minHeight: 48, paddingLeft: 14 },
  alternateRow: { backgroundColor: theme.colors.surfaceSubtle },
  nameCell: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 10 },
  fileName: { flex: 1, color: theme.colors.textPrimary, fontSize: 14 },
  date: { width: 112, fontSize: 11, color: theme.colors.textSecondary },
  copyColumn: { width: 44 },
  loading: { marginVertical: 10 },
  status: { fontSize: 12, color: theme.colors.textSecondary, paddingHorizontal: 14, paddingVertical: 6 },
  error: { fontSize: 13, color: theme.colors.dangerTextStrong, padding: 14 },
  empty: { color: theme.colors.textMuted, textAlign: "center", padding: 28 },
}));
