import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useRunnerWs } from "./RunnerWsProvider";

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
  const elapsedMs = Math.max(0, nowMs - atMs);
  if (elapsedMs < 1000) return "now";
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function formatReadyState(value: unknown) {
  const readyState = Number(value);
  if (readyState === 0) return "connecting";
  if (readyState === 1) return "open";
  if (readyState === 2) return "closing";
  if (readyState === 3) return "closed";
  return "-";
}

function statusForCount(countRaw: unknown) {
  return Number(countRaw || 0) > 0 ? STATUS_WARN : STATUS_OK;
}

function dataSyncColor(status: RunnerWsDataSyncStatus["status"]) {
  if (status === "ok") return STATUS_OK;
  if (status === "loading" || status === "stale") return STATUS_WARN;
  if (status === "error") return STATUS_BAD;
  return STATUS_NEUTRAL;
}

function dataSyncLabel(dataSync: RunnerWsDataSyncStatus) {
  if (dataSync.label) return dataSync.label;
  if (dataSync.status === "ok") return "同期OK";
  if (dataSync.status === "loading") return "取得中";
  if (dataSync.status === "stale") return "未更新";
  if (dataSync.status === "error") return "取得失敗";
  return "同期不明";
}

export function RunnerWsConnectionStatus({ turnState = "", dataSync }: RunnerWsConnectionStatusProps) {
  const runnerWs = useRunnerWs();
  const [open, setOpen] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const nowMs = Date.now();
  const snapshot = runnerWs.snapshot;
  const serverStatus = snapshot.serverStatus || {};
  const sheetMaxHeight = Math.max(280, Math.floor(windowHeight * 0.86));
  const detailMaxHeight = Math.max(170, sheetMaxHeight - 88);
  const status = useMemo(() => {
    if (!runnerWs.enabled || !snapshot.connected) {
      return {
        label: "通信 断",
        color: STATUS_BAD,
      };
    }
    const hasExpoWarning = Number(snapshot.consecutiveMissedPingCount || 0) > 0;
    const hasUpstreamWarning = (
      Number(serverStatus.activeRelayCount || 0) > 0 &&
      serverStatus.upstreamOpen === false
    ) || Number(serverStatus.upstreamQueueCount || 0) > 0;
    if (hasExpoWarning || hasUpstreamWarning) {
      return {
        label: "通信 注意",
        color: STATUS_WARN,
      };
    }
    return {
      label: "通信 良好",
      color: STATUS_OK,
    };
  }, [
    runnerWs.enabled,
    serverStatus.activeRelayCount,
    serverStatus.upstreamOpen,
    serverStatus.upstreamQueueCount,
    snapshot.consecutiveMissedPingCount,
    snapshot.connected,
  ]);

  const expoRows: Array<[string, string]> = [
    ["接続状態", snapshot.connected ? "open" : "closed"],
    ["RTT", snapshot.lastPingRttMs != null ? `${Math.round(snapshot.lastPingRttMs)}ms` : "-"],
    ["送信 / 受信", `${snapshot.sentCount ?? 0} / ${snapshot.receivedCount ?? 0}`],
    ["再接続回数", String(snapshot.reconnectCount ?? 0)],
    ["errors", String(snapshot.errorCount ?? 0)],
    ["missed now/total", `${snapshot.consecutiveMissedPingCount ?? 0} / ${snapshot.missedPingCount ?? 0}`],
    ["last received", formatAge(nowMs, snapshot.lastMessageAtMs)],
  ];
  const upstreamOpenKnown = typeof serverStatus.upstreamOpen === "boolean";
  const upstreamColor = upstreamOpenKnown
    ? (serverStatus.upstreamOpen ? STATUS_OK : STATUS_BAD)
    : STATUS_NEUTRAL;
  const appFlowTurn = String(turnState || serverStatus.turnState || "").trim() || "-";
  const syncLabel = dataSync ? dataSyncLabel(dataSync) : "";
  const syncColor = dataSync ? dataSyncColor(dataSync.status) : STATUS_NEUTRAL;
  const syncLastUpdatedAge = dataSync
    ? (dataSync.lastUpdatedAgeText || formatAge(nowMs, dataSync.lastUpdatedAtMs))
    : "-";

  return (
    <>
      <Pressable
        style={componentStyles.badge}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Runner WS通信状態を開く"
      >
        <View style={[componentStyles.dot, { backgroundColor: status.color }]} />
        <Text style={componentStyles.badgeText}>{status.label}</Text>
        <Text style={componentStyles.badgeSubText}>
          {snapshot.lastPingRttMs != null ? `${Math.round(snapshot.lastPingRttMs)}ms` : "-"}
        </Text>
        {dataSync ? (
          <>
            <Text style={componentStyles.badgeSeparator}>/</Text>
            <View style={[componentStyles.dot, componentStyles.syncDot, { backgroundColor: syncColor }]} />
            <Text style={componentStyles.badgeSubText}>{syncLabel}</Text>
          </>
        ) : null}
        <Text style={componentStyles.chevron}>›</Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={componentStyles.backdrop}>
          <Pressable
            style={componentStyles.backdropDismiss}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="通信状態を閉じる"
          />
          <View style={[componentStyles.sheet, { maxHeight: sheetMaxHeight }]}>
            <View style={componentStyles.sheetHeader}>
              <View>
                <Text style={componentStyles.sheetTitle}>通信状態</Text>
                <Text style={componentStyles.sheetSubtitle}>Runner WS</Text>
              </View>
              <Pressable
                style={componentStyles.closeButton}
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="通信状態を閉じる"
              >
                <Text style={componentStyles.close}>×</Text>
              </Pressable>
            </View>
            <ScrollView
              style={[componentStyles.detailScroll, { maxHeight: detailMaxHeight }]}
              contentContainerStyle={componentStyles.detailScrollContent}
              showsVerticalScrollIndicator
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              <StatusCard
                title="Expo → runner"
                color={status.color}
                rows={expoRows}
              />
              <StatusCard
                title="runner → codex"
                color={upstreamColor}
                rows={[
                  ["upstream", upstreamOpenKnown ? (serverStatus.upstreamOpen ? "open" : "closed") : "-"],
                  ["readyState", formatReadyState(serverStatus.upstreamReadyState)],
                  ["queue", String(serverStatus.upstreamQueueCount ?? 0)],
                  ["last seq", String(serverStatus.lastSeq ?? "-")],
                ]}
              />
              <StatusCard
                title="app flow"
                color={statusForCount(serverStatus.pendingApprovalCount)}
                rows={[
                  ["pending RPC", String(serverStatus.pendingRpcCount ?? 0)],
                  ["pending approvals", String(serverStatus.pendingApprovalCount ?? 0)],
                  ["turn", appFlowTurn],
                  ["last event", formatAge(nowMs, serverStatus.lastEventAtMs)],
                ]}
              />
              {dataSync ? (
                <StatusCard
                  title="session data"
                  color={syncColor}
                  rows={[
                    ["状態", syncLabel],
                    ["detail", dataSync.detail || "-"],
                    ["total", String(dataSync.totalCount ?? "-")],
                    ["loading", String(dataSync.loadingCount ?? 0)],
                    ["stale", String(dataSync.staleCount ?? 0)],
                    ["errors", String(dataSync.errorCount ?? 0)],
                    ["last update", syncLastUpdatedAge],
                  ]}
                />
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function StatusCard({
  title,
  color,
  rows,
}: {
  title: string;
  color: string;
  rows: Array<[string, string]>;
}) {
  return (
    <View style={componentStyles.card}>
      <View style={componentStyles.cardHeader}>
        <Text style={componentStyles.cardTitle}>{title}</Text>
        <View style={[componentStyles.dot, { backgroundColor: color }]} />
      </View>
      <View style={componentStyles.grid}>
        {rows.map(([label, value]) => (
          <View key={label} style={componentStyles.cell}>
            <Text style={componentStyles.cellLabel}>{label}</Text>
            <Text style={componentStyles.cellValue} numberOfLines={1}>{value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const componentStyles = StyleSheet.create({
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
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  syncDot: {
    width: 7,
    height: 7,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
  },
  badgeSubText: {
    minWidth: 34,
    fontSize: 12,
    color: "#64748b",
    textAlign: "right",
  },
  badgeSeparator: {
    fontSize: 12,
    color: "#cbd5e1",
  },
  chevron: {
    fontSize: 18,
    lineHeight: 18,
    color: "#94a3b8",
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.36)",
  },
  backdropDismiss: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 26,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: "#ffffff",
  },
  sheetHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  detailScroll: {
    flexGrow: 0,
  },
  detailScrollContent: {
    paddingBottom: 2,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a",
  },
  sheetSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: "#64748b",
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  close: {
    fontSize: 28,
    lineHeight: 30,
    color: "#334155",
  },
  card: {
    marginTop: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#0f172a",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  cell: {
    width: "50%",
    minHeight: 42,
    paddingVertical: 5,
    paddingRight: 8,
  },
  cellLabel: {
    fontSize: 11,
    color: "#64748b",
  },
  cellValue: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: "700",
    color: "#0f172a",
  },
});
