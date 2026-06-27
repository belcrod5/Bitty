import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

type RunnerWsConnectionStatusProps = {
  turnState?: string;
  dataSync?: RunnerWsDataSyncStatus;
};

const STATUS_OK = "#16a34a";
const STATUS_WARN = "#d97706";
const STATUS_BAD = "#dc2626";
const STATUS_NEUTRAL = "#64748b";

export type RunnerWsDataSyncStatus = {
  status: "ok" | "loading" | "stale" | "error" | "unknown";
  label?: string;
  detail?: string;
  totalCount?: number;
  loadingCount?: number;
  staleCount?: number;
  errorCount?: number;
  lastUpdatedAtMs?: number;
  lastUpdatedAgeText?: string;
};

function formatAge(nowMs: number, atMsRaw: unknown) {
  const atMs = Number(atMsRaw || 0);
  if (!Number.isFinite(atMs) || atMs <= 0) return "-";
  const seconds = Math.floor(Math.max(0, nowMs - atMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function statusColor(status: RunnerWsDataSyncStatus["status"]) {
  if (status === "ok") return STATUS_OK;
  if (status === "loading" || status === "stale") return STATUS_WARN;
  if (status === "error") return STATUS_BAD;
  return STATUS_NEUTRAL;
}

function statusLabel(dataSync?: RunnerWsDataSyncStatus) {
  if (!dataSync) return "同期状態なし";
  if (dataSync.label) return dataSync.label;
  if (dataSync.status === "ok") return "同期OK";
  if (dataSync.status === "loading") return "取得中";
  if (dataSync.status === "stale") return "未更新";
  if (dataSync.status === "error") return "取得失敗";
  return "同期不明";
}

export function RunnerWsConnectionStatus({ turnState = "", dataSync }: RunnerWsConnectionStatusProps) {
  const [open, setOpen] = useState(false);
  const label = statusLabel(dataSync);
  const color = dataSync ? statusColor(dataSync.status) : STATUS_NEUTRAL;
  const rows = [
    ["状態", label],
    ["詳細", dataSync?.detail || "-"],
    ["セッション", String(dataSync?.totalCount ?? "-")],
    ["取得中", String(dataSync?.loadingCount ?? 0)],
    ["未更新", String(dataSync?.staleCount ?? 0)],
    ["エラー", String(dataSync?.errorCount ?? 0)],
    ["最終更新", dataSync?.lastUpdatedAgeText || formatAge(Date.now(), dataSync?.lastUpdatedAtMs)],
    ["処理状態", String(turnState || "-")],
  ];

  return (
    <>
      <Pressable
        style={styles.badge}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="セッション同期状態を開く"
      >
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.badgeText}>{label}</Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>セッション同期状態</Text>
              <Pressable onPress={() => setOpen(false)} accessibilityLabel="同期状態を閉じる">
                <Text style={styles.close}>×</Text>
              </Pressable>
            </View>
            <View style={styles.grid}>
              {rows.map(([rowLabel, value]) => (
                <View key={rowLabel} style={styles.cell}>
                  <Text style={styles.cellLabel}>{rowLabel}</Text>
                  <Text style={styles.cellValue} numberOfLines={2}>{value}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-end",
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  dot: { width: 8, height: 8, borderRadius: 999 },
  badgeText: { fontSize: 12, fontWeight: "700", color: "#0f172a" },
  chevron: { fontSize: 18, lineHeight: 18, color: "#94a3b8" },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.36)",
  },
  sheet: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 26,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: "#ffffff",
  },
  header: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { fontSize: 16, fontWeight: "800", color: "#0f172a" },
  close: { fontSize: 28, lineHeight: 30, color: "#334155" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: "50%",
    minHeight: 48,
    paddingVertical: 5,
    paddingRight: 8,
  },
  cellLabel: { fontSize: 11, color: "#64748b" },
  cellValue: { marginTop: 2, fontSize: 14, fontWeight: "700", color: "#0f172a" },
});
