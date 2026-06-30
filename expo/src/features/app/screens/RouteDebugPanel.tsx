import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useAppSettings } from "../contexts/AppSettingsContext";

type RouteDebugProbe = {
  label: string;
  url: string;
  status: string;
  ok: boolean;
  error: string;
};

type RouteDebugState = {
  checkedAt: string;
  selectedRoute: string;
  diagnosis: string;
  currentRunnerUrl: string;
  currentCodexWsUrl: string;
  localRunnerUrl: string;
  localRunnerWsUrl: string;
  cloudflareRunnerUrl: string;
  runnerTokenStatus: string;
  codexWsTokenStatus: string;
  probes: RouteDebugProbe[];
};

type RouteDebugPanelProps = {
  pairingStatus: string;
  monitorError: string;
  lastPairingLocalRunnerUrl: string | null;
  lastPairingRawText: string;
};

function normalizeRunnerBaseUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildHealthUrl(value: string) {
  const baseUrl = normalizeRunnerBaseUrl(value);
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sameOrigin(left: string, right: string) {
  const leftBase = normalizeRunnerBaseUrl(left);
  const rightBase = normalizeRunnerBaseUrl(right);
  if (!leftBase || !rightBase) return false;
  try {
    return new URL(leftBase).origin === new URL(rightBase).origin;
  } catch {
    return leftBase === rightBase;
  }
}

function selectedRouteLabel(runnerUrl: string, localRunnerUrl: string, cloudflareRunnerUrl: string) {
  if (sameOrigin(runnerUrl, localRunnerUrl)) return "local";
  if (sameOrigin(runnerUrl, cloudflareRunnerUrl)) return "cloudflare";
  if (!normalizeRunnerBaseUrl(runnerUrl)) return "unset";
  return "custom";
}

function tokenStatus(value: string) {
  const token = String(value || "").trim();
  return token ? `保存済み (${token.length} chars, id ${debugTokenId(token)})` : "未設定";
}

function debugTokenId(raw: string) {
  const token = String(raw || "").trim();
  if (!token) return "-";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function routeDiagnosis(localRunnerUrl: string, cloudflareRunnerUrl: string, selectedRoute: string) {
  if (!localRunnerUrl && cloudflareRunnerUrl) {
    return "QRからlocalRunnerUrlが保存されていません。pairing-qrのlocalRunnerUrl行を確認して再スキャンしてください。";
  }
  if (selectedRoute === "cloudflare" && localRunnerUrl) {
    return "local候補はあります。local /health with Authorization がNGならtokenまたはiOSのローカル通信を確認してください。";
  }
  if (selectedRoute === "local") {
    return "local候補が選択されています。";
  }
  return "";
}

function fetchErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "request failed");
}

function exactJapanTime(value: string) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function buildRouteDebugReport(params: {
  routeDebug: RouteDebugState | null;
  lastPairingLocalRunnerUrl: string | null;
  lastPairingRawText: string;
  pairingStatus: string;
  monitorError: string;
}) {
  const { routeDebug, lastPairingLocalRunnerUrl, lastPairingRawText, pairingStatus, monitorError } = params;
  const lines = ["Runner Connection Monitor Debug"];
  if (pairingStatus) lines.push(`pairingStatus: ${pairingStatus}`);
  if (monitorError) lines.push(`monitorError: ${monitorError}`);
  if (lastPairingLocalRunnerUrl !== null) {
    lines.push(`lastPairingLocalRunnerUrl: ${lastPairingLocalRunnerUrl || "-"}`);
  }
  lines.push("lastPairingRawText:");
  lines.push(lastPairingRawText || "-");
  if (!routeDebug) return lines.join("\n");

  lines.push("");
  lines.push(`Route Debug selected: ${routeDebug.selectedRoute}`);
  lines.push(`checked: ${routeDebug.checkedAt}`);
  lines.push(`current runnerUrl: ${routeDebug.currentRunnerUrl || "-"}`);
  lines.push(`current codexWsUrl: ${routeDebug.currentCodexWsUrl || "-"}`);
  lines.push(`local candidate: ${routeDebug.localRunnerUrl || "-"}`);
  lines.push(`local ws candidate: ${routeDebug.localRunnerWsUrl || "-"}`);
  lines.push(`cloudflare candidate: ${routeDebug.cloudflareRunnerUrl || "-"}`);
  lines.push(`runnerToken: ${routeDebug.runnerTokenStatus}`);
  lines.push(`codexWsToken: ${routeDebug.codexWsTokenStatus}`);
  if (routeDebug.diagnosis) lines.push(`diagnosis: ${routeDebug.diagnosis}`);
  for (const probe of routeDebug.probes) {
    lines.push(`${probe.ok ? "OK" : "NG"} ${probe.label}: ${probe.status}`);
    lines.push(probe.url);
    if (probe.error) lines.push(probe.error);
  }
  return lines.join("\n");
}

async function fetchProbe(
  label: string,
  url: string,
  options: RequestInit,
  timeoutMs = 5000
): Promise<RouteDebugProbe> {
  if (!url) {
    return { label, url: "-", status: "missing_url", ok: false, error: "" };
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await response.text();
    return {
      label,
      url,
      status: `HTTP ${response.status}`,
      ok: response.ok,
      error: response.ok ? "" : text.slice(0, 180),
    };
  } catch (error) {
    return {
      label,
      url,
      status: "failed",
      ok: false,
      error: fetchErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function RouteDebugPanel({
  pairingStatus,
  monitorError,
  lastPairingLocalRunnerUrl,
  lastPairingRawText,
}: RouteDebugPanelProps) {
  const {
    runnerUrl,
    codexWsUrl,
    codexWsToken,
    runnerToken,
    cloudflareRunnerUrl,
    localRunnerUrl,
    localRunnerWsUrl,
  } = useAppSettings();
  const [showDetails, setShowDetails] = useState(false);
  const [routeDebug, setRouteDebug] = useState<RouteDebugState | null>(null);
  const [routeDebugLoading, setRouteDebugLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const routeDebugReport = useMemo(() => buildRouteDebugReport({
    routeDebug,
    lastPairingLocalRunnerUrl,
    lastPairingRawText,
    pairingStatus,
    monitorError,
  }), [lastPairingLocalRunnerUrl, lastPairingRawText, monitorError, pairingStatus, routeDebug]);

  const copyRouteDebugReport = useCallback(async () => {
    await Clipboard.setStringAsync(routeDebugReport);
    setCopyStatus("Debugをコピーしました。");
  }, [routeDebugReport]);

  const refreshRouteDebug = useCallback(async () => {
    const currentRunnerUrl = normalizeRunnerBaseUrl(runnerUrl);
    const localUrl = normalizeRunnerBaseUrl(localRunnerUrl);
    const cloudflareUrl = normalizeRunnerBaseUrl(cloudflareRunnerUrl);
    const token = String(runnerToken || "").trim();
    const localHealthUrl = buildHealthUrl(localUrl);
    const currentEventsUrl = currentRunnerUrl
      ? `${currentRunnerUrl}/runner/connection-events?limit=1`
      : "";

    setRouteDebugLoading(true);
    try {
      const probes = await Promise.all([
        fetchProbe("iOS app local /health", localHealthUrl, { method: "GET" }),
        fetchProbe("local /health with Authorization", localHealthUrl, {
          method: "GET",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        fetchProbe("current runner authenticated API", currentEventsUrl, {
          method: "GET",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      ]);
      const selectedRoute = selectedRouteLabel(currentRunnerUrl, localUrl, cloudflareUrl);
      setRouteDebug({
        checkedAt: new Date().toISOString(),
        selectedRoute,
        diagnosis: routeDiagnosis(localUrl, cloudflareUrl, selectedRoute),
        currentRunnerUrl,
        currentCodexWsUrl: String(codexWsUrl || "").trim(),
        localRunnerUrl: localUrl,
        localRunnerWsUrl: String(localRunnerWsUrl || "").trim(),
        cloudflareRunnerUrl: cloudflareUrl,
        runnerTokenStatus: tokenStatus(runnerToken),
        codexWsTokenStatus: tokenStatus(codexWsToken),
        probes,
      });
    } finally {
      setRouteDebugLoading(false);
    }
  }, [cloudflareRunnerUrl, codexWsToken, codexWsUrl, localRunnerUrl, localRunnerWsUrl, runnerToken, runnerUrl]);

  useEffect(() => {
    if (!showDetails) return;
    void refreshRouteDebug();
  }, [refreshRouteDebug, showDetails]);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.label}>Route Debug</Text>
        {showDetails ? (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.linkButton}
              disabled={routeDebugLoading}
              onPress={() => void refreshRouteDebug()}
            >
              <Text style={styles.linkButtonText}>{routeDebugLoading ? "確認中" : "更新"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => void copyRouteDebugReport()}
            >
              <Text style={styles.linkButtonText}>コピー</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => setShowDetails(false)}
            >
              <Text style={styles.linkButtonText}>非表示</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => setShowDetails(true)}
          >
            <Text style={styles.linkButtonText}>表示</Text>
          </TouchableOpacity>
        )}
      </View>
      {showDetails ? (
        <>
          {copyStatus ? <Text style={styles.meta}>{copyStatus}</Text> : null}
          {routeDebug ? (
            <View style={styles.detailBox}>
              <Text style={styles.meta}>selected: {routeDebug.selectedRoute}</Text>
              <Text style={styles.meta}>checked: {exactJapanTime(routeDebug.checkedAt)}</Text>
              <Text style={styles.meta}>current runnerUrl: {routeDebug.currentRunnerUrl || "-"}</Text>
              <Text style={styles.meta}>current codexWsUrl: {routeDebug.currentCodexWsUrl || "-"}</Text>
              <Text style={styles.meta}>local candidate: {routeDebug.localRunnerUrl || "-"}</Text>
              <Text style={styles.meta}>local ws candidate: {routeDebug.localRunnerWsUrl || "-"}</Text>
              <Text style={styles.meta}>cloudflare candidate: {routeDebug.cloudflareRunnerUrl || "-"}</Text>
              <Text style={styles.meta}>runnerToken: {routeDebug.runnerTokenStatus}</Text>
              <Text style={styles.meta}>codexWsToken: {routeDebug.codexWsTokenStatus}</Text>
              {lastPairingLocalRunnerUrl !== null ? (
                <Text style={styles.meta}>last pairing localRunnerUrl: {lastPairingLocalRunnerUrl || "-"}</Text>
              ) : null}
              <Text style={styles.meta}>last pairing raw text:</Text>
              <Text selectable style={styles.rawText}>{lastPairingRawText || "-"}</Text>
              {routeDebug.diagnosis ? <Text style={styles.error}>{routeDebug.diagnosis}</Text> : null}
              {routeDebug.probes.map((probe) => (
                <View key={probe.label} style={styles.probeRow}>
                  <Text style={[styles.probeStatus, probe.ok ? styles.probeOk : styles.probeNg]}>
                    {probe.ok ? "OK" : "NG"}
                  </Text>
                  <View style={styles.probeText}>
                    <Text style={styles.meta}>{probe.label}: {probe.status}</Text>
                    <Text style={styles.hint}>{probe.url}</Text>
                    {probe.error ? <Text style={styles.error}>{probe.error}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.meta}>local疎通、Authorization付き疎通、現在runner APIを確認します。</Text>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
  meta: {
    color: "#475569",
    fontSize: 12,
  },
  hint: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 17,
  },
  rawText: {
    color: "#334155",
    fontFamily: "Courier",
    fontSize: 11,
    lineHeight: 15,
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
  probeRow: {
    alignItems: "flex-start",
    borderTopColor: "#e2e8f0",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingTop: 8,
  },
  probeStatus: {
    borderRadius: 6,
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  probeOk: {
    backgroundColor: "#16a34a",
  },
  probeNg: {
    backgroundColor: "#dc2626",
  },
  probeText: {
    flex: 1,
    gap: 2,
  },
});
