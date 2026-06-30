import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useAppShell } from "../contexts/AppShellContext";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { RouteDebugPanel } from "./RouteDebugPanel";

type RunnerConnectionEvent = {
  seq: number;
  at: string;
  firstAt?: string;
  lastAt?: string;
  groupKey?: string;
  repeatCount?: number;
  type: string;
  connectionId: string;
  route: string;
  endpoint: string;
  cfConnectingIpHint: string;
  cfRay: string;
  cfIpCountry: string;
  userAgent: string;
  tokenSource: string;
  hasAuthHeaderToken: boolean;
  hasQueryToken: boolean;
  reason: string;
  closeCode: number | null;
};

function normalizeRunnerBaseUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function eventLabel(type: string) {
  switch (type) {
    case "connection_opened":
      return "許可";
    case "connection_rejected":
      return "拒否";
    case "connection_closed":
      return "切断";
    case "connection_error":
      return "エラー";
    default:
      return type || "不明";
  }
}

function eventIcon(type: string) {
  switch (type) {
    case "connection_opened":
      return "✓";
    case "connection_rejected":
      return "!";
    case "connection_closed":
      return "×";
    case "connection_error":
      return "!";
    default:
      return "?";
  }
}

function eventTone(type: string) {
  switch (type) {
    case "connection_opened":
      return "success";
    case "connection_rejected":
    case "connection_error":
      return "danger";
    default:
      return "muted";
  }
}

function isAllowedEvent(event: RunnerConnectionEvent) {
  return event.type === "connection_opened";
}

function isAttentionEvent(event: RunnerConnectionEvent) {
  return event.type === "connection_rejected" || event.type === "connection_error";
}

function parseEventDate(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function relativeTime(value: string, nowMs: number) {
  const date = parseEventDate(value);
  if (!date) return "-";
  const diffSeconds = Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}秒前`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}時間前`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}日前`;
}

function exactJapanTime(value: string) {
  const date = parseEventDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function shortRoute(event: RunnerConnectionEvent) {
  return event.route || event.endpoint || "-";
}

function eventIdentity(event: RunnerConnectionEvent) {
  return String(event.groupKey || event.seq);
}

function mergeEventHistory(current: RunnerConnectionEvent[], incoming: RunnerConnectionEvent[]) {
  const byIdentity = new Map<string, RunnerConnectionEvent>();
  for (const item of current) byIdentity.set(eventIdentity(item), item);
  for (const item of incoming) byIdentity.set(eventIdentity(item), item);
  return Array.from(byIdentity.values()).sort((a, b) => b.seq - a.seq).slice(0, 200);
}

function cloudflareAccessRecoveryHint(status: number, message: string) {
  const rawMessage = String(message || "").trim().toLowerCase();
  if (status === 401 && rawMessage === "unauthorized") {
    return "RUNNER_TOKENが現在起動中のprivate runnerと一致していません。Runner起動後にPairing QRを再表示し、読み直してください。";
  }
  const text = `${status} ${message}`.toLowerCase();
  if (status !== 401 && status !== 403 && !text.includes("cloudflare access")) return "";
  return "Cloudflare AccessのService Tokenが期限切れ・失効・未許可の可能性があります。Cloudflare DashboardでService Tokenを再作成し、Mac Keychainへ保存してからPairing QRを読み直してください。";
}

function ConnectionEventCard({
  event,
  expanded,
  nowMs,
  onToggle,
}: {
  event: RunnerConnectionEvent;
  expanded: boolean;
  nowMs: number;
  onToggle: () => void;
}) {
  const tone = eventTone(event.type);
  const repeatCount = Math.max(1, Number(event.repeatCount || 1));
  const repeatLabel = event.type === "connection_opened" ? "同じ接続元" : "同じ拒否";

  return (
    <TouchableOpacity
      style={[
        screenStyles.eventCard,
        tone === "success" ? screenStyles.eventCardSuccess : screenStyles.eventCardDanger,
      ]}
      onPress={onToggle}
    >
      <View style={screenStyles.eventMainRow}>
        <Text style={[screenStyles.eventIcon, tone === "success" ? screenStyles.eventIconSuccess : screenStyles.eventIconDanger]}>
          {eventIcon(event.type)}
        </Text>
        <View style={screenStyles.eventMainText}>
          <View style={screenStyles.eventTitleRow}>
            <Text style={screenStyles.eventStatus}>{eventLabel(event.type)}</Text>
            <Text style={screenStyles.eventRoute}>{shortRoute(event)}</Text>
          </View>
          <Text style={screenStyles.eventTime}>{relativeTime(event.at, nowMs)}</Text>
          {repeatCount > 1 ? (
            <Text style={screenStyles.eventSubText}>{repeatLabel} {repeatCount}回</Text>
          ) : null}
        </View>
        <Text style={screenStyles.expandText}>{expanded ? "閉じる" : "詳細"}</Text>
      </View>
      {expanded ? (
        <View style={screenStyles.eventDetails}>
          <Text style={screenStyles.meta}>時刻: {exactJapanTime(event.at)}</Text>
          {event.firstAt && repeatCount > 1 ? <Text style={screenStyles.meta}>初回: {exactJapanTime(event.firstAt)}</Text> : null}
          <Text style={screenStyles.meta}>seq: {event.seq}</Text>
          <Text style={screenStyles.meta}>connection: {event.connectionId || "-"}</Text>
          <Text style={screenStyles.meta}>country: {event.cfIpCountry || "-"}</Text>
          <Text style={screenStyles.meta}>ip: {event.cfConnectingIpHint || "-"}</Text>
          <Text style={screenStyles.meta}>token: {event.tokenSource || "-"}</Text>
          {event.reason ? <Text style={screenStyles.meta}>reason: {event.reason}</Text> : null}
          {event.cfRay ? <Text style={screenStyles.meta}>cf-ray: {event.cfRay}</Text> : null}
          {event.userAgent ? <Text style={screenStyles.meta}>ua: {event.userAgent}</Text> : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export function CloudflareTunnelMonitorScreen() {
  const { openMiniBoardScreen, openDrawer } = useAppShell();
  const {
    runnerUrl,
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessEnabled,
    applyCloudflareRunnerPairing,
    clearCloudflareAccessCredentials,
  } = useAppSettings();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairingStatus, setPairingStatus] = useState("");
  const [events, setEvents] = useState<RunnerConnectionEvent[]>([]);
  const [allowedEvents, setAllowedEvents] = useState<RunnerConnectionEvent[]>([]);
  const [activeConnections, setActiveConnections] = useState<RunnerConnectionEvent[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [latestSeq, setLatestSeq] = useState(0);
  const latestSeqRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState("");
  const [error, setError] = useState("");
  const [latestAllowedEvent, setLatestAllowedEvent] = useState<RunnerConnectionEvent | null>(null);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [showStatusDetails, setShowStatusDetails] = useState(false);
  const [showAllAllowedEvents, setShowAllAllowedEvents] = useState(false);
  const [showAllAttentionEvents, setShowAllAttentionEvents] = useState(false);
  const [expandedEventKeys, setExpandedEventKeys] = useState<Set<string>>(() => new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastPairingLocalRunnerUrl, setLastPairingLocalRunnerUrl] = useState<string | null>(null);
  const [lastPairingRawText, setLastPairingRawText] = useState("");

  const attentionEvents = useMemo(
    () => events.filter(isAttentionEvent).slice(0, showAllAttentionEvents ? 200 : 12),
    [events, showAllAttentionEvents]
  );
  const recentAllowedEvents = useMemo(
    () => allowedEvents.slice(0, showAllAllowedEvents ? 200 : 12),
    [allowedEvents, showAllAllowedEvents]
  );
  const hasRunnerSettings = Boolean(normalizeRunnerBaseUrl(runnerUrl) && String(runnerToken || "").trim());
  const hasAccessSettings = Boolean(cloudflareAccessEnabled && cloudflareAccessClientId);

  const toggleEventDetails = useCallback((identity: string) => {
    setExpandedEventKeys((current) => {
      const next = new Set(current);
      if (next.has(identity)) {
        next.delete(identity);
      } else {
        next.add(identity);
      }
      return next;
    });
  }, []);

  const fetchEvents = useCallback(async () => {
    const baseUrl = normalizeRunnerBaseUrl(runnerUrl);
    const token = String(runnerToken || "").trim();
    if (!baseUrl || !token) {
      setError("runner URL と RUNNER_TOKEN が必要です。");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `${baseUrl}/runner/connection-events?sinceSeq=${encodeURIComponent(String(latestSeqRef.current))}&limit=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const rawBody = await response.text();
      let body: any = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        body = { message: rawBody.slice(0, 180) };
      }
      if (!response.ok || !body?.ok) {
        const message = String(body?.message || body?.error || `HTTP ${response.status}`);
        const hint = cloudflareAccessRecoveryHint(response.status, message);
        throw new Error(hint ? `${message}\n${hint}` : message);
      }

      const nextEvents = Array.isArray(body.events) ? body.events as RunnerConnectionEvent[] : [];
      const nextAllowedEvents = Array.isArray(body.allowedEvents) ? body.allowedEvents as RunnerConnectionEvent[] : [];
      const nextLatestSeq = Number(body.latestSeq || latestSeqRef.current);
      latestSeqRef.current = Number.isFinite(nextLatestSeq) ? nextLatestSeq : latestSeqRef.current;
      setLatestSeq(latestSeqRef.current);
      setFetchedAt(String(body.fetchedAt || ""));
      setActiveCount(Number(body.activeCount || 0));
      setActiveConnections(Array.isArray(body.activeConnections) ? body.activeConnections as RunnerConnectionEvent[] : []);
      if (body.latestAllowedEvent && typeof body.latestAllowedEvent === "object") {
        setLatestAllowedEvent(body.latestAllowedEvent as RunnerConnectionEvent);
      } else {
        const fallbackAllowedEvent = nextAllowedEvents.find(isAllowedEvent);
        if (fallbackAllowedEvent) setLatestAllowedEvent(fallbackAllowedEvent);
      }
      setEvents((current) => mergeEventHistory(current, nextEvents));
      setAllowedEvents((current) => mergeEventHistory(current, nextAllowedEvents));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runnerToken, runnerUrl]);

  useEffect(() => {
    void fetchEvents();
    const timer = setInterval(() => {
      void fetchEvents();
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchEvents]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <SafeAreaView style={screenStyles.safeArea}>
      <ScrollView contentContainerStyle={screenStyles.content}>
        <View style={screenStyles.menuRow}>
          <TouchableOpacity
            style={screenStyles.menuButton}
            onPress={() => {
              openMiniBoardScreen();
              openDrawer();
            }}
          >
            <Text style={screenStyles.menuButtonText}>← Menu</Text>
          </TouchableOpacity>
        </View>

        <View style={screenStyles.header}>
          <View>
            <Text style={screenStyles.title}>Runner Connection Monitor</Text>
          </View>
          {loading ? <ActivityIndicator /> : null}
        </View>

        <View style={screenStyles.card}>
          <View style={screenStyles.cardHeader}>
            <View>
              <Text style={screenStyles.label}>接続設定</Text>
              <Text style={screenStyles.compactStatus}>
                Runner {hasRunnerSettings ? "OK" : "未設定"} / Access {hasAccessSettings ? "OK" : "未設定"}
              </Text>
            </View>
            <TouchableOpacity style={screenStyles.linkButton} onPress={() => setShowConnectionSettings((value) => !value)}>
              <Text style={screenStyles.linkButtonText}>{showConnectionSettings ? "閉じる" : "詳細"}</Text>
            </TouchableOpacity>
          </View>
          {pairingStatus ? <Text style={screenStyles.meta}>{pairingStatus}</Text> : null}
          <View style={screenStyles.buttonRow}>
            <TouchableOpacity
              style={screenStyles.button}
              onPress={async () => {
                const permission = cameraPermission?.granted
                  ? cameraPermission
                  : await requestCameraPermission();
                if (!permission.granted) {
                  setPairingStatus("カメラ権限が必要です。");
                  return;
                }
                setPairingStatus("Runner起動ターミナルのQRを読み取ってください。");
                setScanning(true);
              }}
            >
              <Text style={screenStyles.buttonText}>Pairing QRを読む</Text>
            </TouchableOpacity>
          </View>
          {showConnectionSettings ? (
            <View style={screenStyles.detailBox}>
              <Text style={screenStyles.meta}>Runner URL: {runnerUrl || "-"}</Text>
              <Text style={screenStyles.meta}>Runner Token: {runnerToken ? "保存済み" : "未設定"}</Text>
              <Text style={screenStyles.meta}>
                Cloudflare Access: {cloudflareAccessEnabled ? `保存済み (${cloudflareAccessClientId.slice(0, 8)}...)` : "未設定"}
              </Text>
              <Text style={screenStyles.hint}>QRは秘密情報です。スクリーンショットや共有は避けてください。</Text>
            </View>
          ) : null}
          {showConnectionSettings ? (
            <TouchableOpacity
              style={[screenStyles.button, screenStyles.dangerButton]}
              onPress={async () => {
                try {
                  await clearCloudflareAccessCredentials();
                  setPairingStatus("Cloudflare Access資格情報を削除しました。");
                } catch (error) {
                  setPairingStatus(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              <Text style={screenStyles.buttonText}>Access資格情報を削除</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {scanning ? (
          <View style={screenStyles.cameraCard}>
            <CameraView
              style={screenStyles.camera}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={async (result: BarcodeScanningResult) => {
                setScanning(false);
                const rawText = String(result.data || "");
                setLastPairingRawText(rawText);
                try {
                  const pairing = await applyCloudflareRunnerPairing(rawText);
                  setLastPairingLocalRunnerUrl(pairing.localRunnerUrl || "");
                  setPairingStatus(
                    `Pairing QRを保存しました。localRunnerUrl: ${pairing.localRunnerUrl || "-"}`
                  );
                } catch (error) {
                  setPairingStatus(error instanceof Error ? error.message : String(error));
                }
              }}
            />
            <TouchableOpacity style={screenStyles.button} onPress={() => setScanning(false)}>
              <Text style={screenStyles.buttonText}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <RouteDebugPanel
          pairingStatus={pairingStatus}
          monitorError={error}
          lastPairingLocalRunnerUrl={lastPairingLocalRunnerUrl}
          lastPairingRawText={lastPairingRawText}
        />

        <View style={screenStyles.card}>
          <View style={screenStyles.cardHeader}>
            <View>
              <Text style={screenStyles.label}>状態</Text>
              <Text style={screenStyles.value}>{error ? "取得エラー" : activeCount > 0 ? `${activeCount} 接続中` : "接続なし"}</Text>
            </View>
            <TouchableOpacity style={screenStyles.linkButton} onPress={() => setShowStatusDetails((value) => !value)}>
              <Text style={screenStyles.linkButtonText}>{showStatusDetails ? "閉じる" : "詳細"}</Text>
            </TouchableOpacity>
          </View>
          {latestAllowedEvent ? (
            <Text style={screenStyles.lastActivity}>
              最終許可: {relativeTime(latestAllowedEvent.at, nowMs)}
            </Text>
          ) : null}
          {showStatusDetails ? (
            <View style={screenStyles.detailBox}>
              <Text style={screenStyles.meta}>latestSeq: {latestSeq || "-"}</Text>
              <Text style={screenStyles.meta}>取得: {fetchedAt ? exactJapanTime(fetchedAt) : "-"}</Text>
            </View>
          ) : null}
          {error ? <Text style={screenStyles.error}>{error}</Text> : null}
        </View>

        {activeConnections.length > 0 ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.label}>接続中</Text>
            {activeConnections.map((event) => (
              <View key={event.connectionId || event.seq} style={[screenStyles.eventCard, screenStyles.eventCardSuccess]}>
                <View style={screenStyles.eventMainRow}>
                  <Text style={[screenStyles.eventIcon, screenStyles.eventIconSuccess]}>{eventIcon("connection_opened")}</Text>
                  <View style={screenStyles.eventMainText}>
                    <Text style={screenStyles.eventTime}>{relativeTime(event.at, nowMs)}</Text>
                    <Text style={screenStyles.eventSubText}>{shortRoute(event)}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        <View style={screenStyles.card}>
          <View style={screenStyles.cardHeader}>
            <Text style={screenStyles.label}>認証成功</Text>
            {allowedEvents.length > 12 ? (
              <TouchableOpacity style={screenStyles.linkButton} onPress={() => setShowAllAllowedEvents((value) => !value)}>
                <Text style={screenStyles.linkButtonText}>{showAllAllowedEvents ? "直近12件" : `全${allowedEvents.length}件`}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {recentAllowedEvents.length <= 0 ? (
            <Text style={screenStyles.meta}>正常な認証履歴はありません。</Text>
          ) : (
            recentAllowedEvents.map((event) => {
              const identity = eventIdentity(event);
              return (
                <ConnectionEventCard
                  key={identity}
                  event={event}
                  expanded={expandedEventKeys.has(identity)}
                  nowMs={nowMs}
                  onToggle={() => toggleEventDetails(identity)}
                />
              );
            })
          )}
        </View>

        <View style={screenStyles.card}>
          <View style={screenStyles.cardHeader}>
            <Text style={screenStyles.label}>拒否・エラー</Text>
            {events.length > 12 ? (
              <TouchableOpacity style={screenStyles.linkButton} onPress={() => setShowAllAttentionEvents((value) => !value)}>
                <Text style={screenStyles.linkButtonText}>{showAllAttentionEvents ? "直近12件" : `全${events.length}件`}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {attentionEvents.length <= 0 ? (
            <Text style={screenStyles.meta}>拒否/エラーログはありません。</Text>
          ) : (
            attentionEvents.map((event) => {
              const identity = eventIdentity(event);
              return (
                <ConnectionEventCard
                  key={identity}
                  event={event}
                  expanded={expandedEventKeys.has(identity)}
                  nowMs={nowMs}
                  onToggle={() => toggleEventDetails(identity)}
                />
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const screenStyles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  content: {
    padding: 16,
    gap: 12,
  },
  menuRow: {
    flexDirection: "row",
  },
  menuButton: {
    backgroundColor: "#e2e8f0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  menuButtonText: {
    color: "#1e293b",
    fontSize: 12,
    fontWeight: "700",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#0f172a",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#cbd5e1",
    gap: 8,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: "#334155",
  },
  value: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
  },
  compactStatus: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 3,
  },
  lastActivity: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "700",
  },
  meta: {
    color: "#475569",
    fontSize: 12,
  },
  hint: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    color: "#b91c1c",
    fontSize: 12,
    lineHeight: 17,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignSelf: "flex-start",
  },
  dangerButton: {
    backgroundColor: "#dc2626",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 12,
  },
  linkButton: {
    backgroundColor: "#f1f5f9",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  linkButtonText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "700",
  },
  detailBox: {
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  cameraCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  camera: {
    height: 260,
    borderRadius: 10,
    overflow: "hidden",
  },
  eventCard: {
    borderRadius: 14,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  eventCardSuccess: {
    backgroundColor: "#ecfdf5",
    borderColor: "#86efac",
  },
  eventCardDanger: {
    backgroundColor: "#fef2f2",
    borderColor: "#fca5a5",
  },
  eventMainRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  eventIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    color: "#ffffff",
    fontSize: 19,
    fontWeight: "900",
    lineHeight: 32,
    textAlign: "center",
  },
  eventIconSuccess: {
    backgroundColor: "#16a34a",
  },
  eventIconDanger: {
    backgroundColor: "#dc2626",
  },
  eventMainText: {
    flex: 1,
    gap: 2,
  },
  eventTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  eventStatus: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800",
  },
  eventRoute: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "700",
  },
  eventTime: {
    color: "#0f172a",
    fontSize: 24,
    fontWeight: "900",
  },
  eventSubText: {
    color: "#475569",
    fontSize: 12,
  },
  expandText: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "700",
  },
  eventDetails: {
    borderTopColor: "rgba(15, 23, 42, 0.12)",
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 3,
    paddingTop: 8,
  },
});
