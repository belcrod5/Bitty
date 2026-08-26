import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type Entry = { kind: "dir" | "file"; name: string; path: string };

type Props = {
  runnerUrl: string;
  runnerToken: string;
  rootPath: string;
  value: string;
  onSelect: (path: string) => void;
};

export function CodexScheduleScriptPicker({ runnerUrl, runnerToken, rootPath, value, onSelect }: Props) {
  const [visible, setVisible] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const baseUrl = String(runnerUrl || "").trim().replace(/\/+$/, "");
    const token = String(runnerToken || "").trim();
    if (!baseUrl || !token) {
      setLoading(false);
      setError("Runnerへ接続する設定がありません。");
      return;
    }
    const url = new URL(`${baseUrl}/directories`);
    url.searchParams.set("path", currentPath);
    void fetch(url.toString(), { headers: { authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new Error(String(data.message || data.error || `HTTP ${response.status}`));
        const nextEntries = Array.isArray(data.entries) ? data.entries.flatMap((raw): Entry[] => {
          if (!raw || typeof raw !== "object") return [];
          const item = raw as Record<string, unknown>;
          const kind = item.kind === "file" ? "file" : item.kind === "dir" ? "dir" : null;
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const path = typeof item.path === "string" ? item.path.trim() : "";
          return kind && name && path ? [{ kind, name, path }] : [];
        }) : [];
        if (cancelled) return;
        setCurrentPath(typeof data.basePath === "string" && data.basePath.trim() ? data.basePath : currentPath);
        setEntries(nextEntries);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentPath, runnerToken, runnerUrl, visible]);

  const open = () => {
    setHistory([]);
    setCurrentPath(rootPath);
    setVisible(true);
  };

  return (
    <>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="実行ファイル" style={styles.field} onPress={open}>
        <Text style={value ? styles.value : styles.placeholder} numberOfLines={2}>{value || ".sh ファイルを選択"}</Text>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setVisible(false)}>
        <SafeAreaView style={styles.root}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="実行ファイル選択を閉じる" onPress={() => setVisible(false)}>
              <Text style={styles.headerAction}>閉じる</Text>
            </TouchableOpacity>
            <Text style={styles.title}>実行ファイル</Text>
            <View style={styles.headerSpacer} />
          </View>
          <View style={styles.pathRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="一つ上のディレクトリへ戻る"
              disabled={history.length === 0 || loading}
              onPress={() => {
                const parent = history[history.length - 1];
                setHistory((current) => current.slice(0, -1));
                setCurrentPath(parent);
              }}
            >
              <Text style={[styles.back, history.length === 0 && styles.disabled]}>‹ 戻る</Text>
            </TouchableOpacity>
            <Text style={styles.path} numberOfLines={2}>{currentPath}</Text>
          </View>
          {loading ? <ActivityIndicator accessibilityLabel="実行ファイルを読込中" style={styles.loading} /> : null}
          {!loading && error ? <Text style={styles.error}>{error}</Text> : null}
          {!loading && !error ? (
            <ScrollView contentContainerStyle={styles.list}>
              {entries.filter((entry) => entry.kind === "dir" || entry.name.toLowerCase().endsWith(".sh")).map((entry) => (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.name}${entry.kind === "dir" ? "を開く" : "を選択"}`}
                  key={`${entry.kind}:${entry.path}`}
                  style={styles.row}
                  onPress={() => {
                    if (entry.kind === "dir") {
                      setHistory((current) => [...current, currentPath]);
                      setCurrentPath(entry.path);
                    } else {
                      onSelect(entry.path);
                      setVisible(false);
                    }
                  }}
                >
                  <Text style={styles.icon}>{entry.kind === "dir" ? "▸" : "#"}</Text>
                  <Text style={styles.name}>{entry.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  field: { minHeight: 44, paddingHorizontal: 10, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  value: { flex: 1, color: "#0f172a", fontSize: 13 },
  placeholder: { flex: 1, color: "#94a3b8", fontSize: 14 },
  chevron: { color: "#64748b", fontSize: 22 },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#cbd5e1", backgroundColor: "#fff" },
  headerAction: { color: "#2563eb", fontSize: 16, minWidth: 48 },
  headerSpacer: { width: 48 },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  pathRow: { minHeight: 56, padding: 12, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#fff" },
  back: { color: "#2563eb", fontWeight: "600" },
  path: { flex: 1, color: "#475569", fontSize: 12 },
  disabled: { opacity: 0.35 },
  loading: { marginTop: 32 },
  error: { margin: 24, color: "#b91c1c", textAlign: "center" },
  list: { padding: 12, gap: 2 },
  row: { minHeight: 46, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 8, backgroundColor: "#fff" },
  icon: { width: 16, color: "#64748b", fontWeight: "700" },
  name: { flex: 1, color: "#0f172a" },
});
