import * as BackgroundTask from "expo-background-task";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";

import { mutatePersistedSettings, readPersistedSettingsField } from "../app/utils/persistedSettingsFile";
import { loadSecureRunnerCredentials } from "../app/utils/secureRunnerCredentials";
import {
  LOCATION_SCHEDULE_TASK_NAME,
  appendPendingLocationState,
  enabledLocationRegions,
  isCoordinateInsideRule,
  locationRuleRevision,
  parseLocationRegionIdentifier,
  parseLocationScheduleRules,
  pendingLocationStatesForRules,
  regionIdentifierForRule,
  removeSentPendingLocationStates,
  type LocationScheduleRule,
  type PendingLocationState,
} from "./locationScheduleRules";

const RULES_FIELD = "locationSchedules";
const PENDING_FIELD = "locationSchedulePendingStates";
const LAST_STATES_FIELD = "locationScheduleLastStates";
const LOCATION_REFRESH_TASK_NAME = "bitty-location-schedule-refresh";
const LOCATION_REFRESH_MINIMUM_INTERVAL_MINUTES = 15;
const LOCATION_PUSH_REFRESH_TASK_NAME = "bitty-location-state-refresh-push";
const LOCATION_PUSH_REFRESH_MARKER = "location_state_refresh";

function rulesInCurrentTimeZone(rules: readonly LocationScheduleRule[]) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return rules.map((rule) => ({ ...rule, timeZone, regionRevision: locationRuleRevision(rule) }));
}

class RunnerRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function runnerEndpoint() {
  const runnerUrl = String(await readPersistedSettingsField("runnerUrl") || "").trim().replace(/\/+$/, "");
  const credentials = await loadSecureRunnerCredentials();
  if (!runnerUrl || !credentials.runnerToken) return null;
  return {
    runnerUrl,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.runnerToken}`,
      ...(credentials.cloudflareAccessClientId && credentials.cloudflareAccessClientSecret ? {
        "CF-Access-Client-Id": credentials.cloudflareAccessClientId,
        "CF-Access-Client-Secret": credentials.cloudflareAccessClientSecret,
      } : {}),
    },
  };
}

async function runnerRequest(path: string, method: "PUT" | "POST", body: Record<string, unknown>) {
  const endpoint = await runnerEndpoint();
  if (!endpoint) throw new Error("Runner connection is not configured");
  const response = await fetch(`${endpoint.runnerUrl}${path}`, {
    method,
    headers: endpoint.headers,
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RunnerRequestError(String((result as any)?.message || `Runner HTTP ${response.status}`), response.status);
  }
  return result;
}

const diagSessionId = `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
let diagSeq = 0;

async function logLocationScheduleEvent(event: string, payload: Record<string, unknown> = {}) {
  try {
    const endpoint = await runnerEndpoint();
    if (!endpoint) return;
    diagSeq += 1;
    await fetch(`${endpoint.runnerUrl}/client-logs`, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({
        source: "location_schedule",
        sessionId: diagSessionId,
        device: `${Platform.OS}:${String(Platform.Version)}`,
        events: [{ sessionId: diagSessionId, seq: diagSeq, at: new Date().toISOString(), event, payload }],
      }),
    });
  } catch {
    // 診断ログの失敗は本体の動作に影響させない
  }
}

async function persistLocationState(event: PendingLocationState) {
  await mutatePersistedSettings((current) => {
    const lastStates = current[LAST_STATES_FIELD] && typeof current[LAST_STATES_FIELD] === "object"
      ? current[LAST_STATES_FIELD] as Record<string, unknown>
      : {};
    return {
      ...current,
      [PENDING_FIELD]: appendPendingLocationState(current[PENDING_FIELD], event),
      [LAST_STATES_FIELD]: { ...lastStates, [event.ruleId]: event },
    };
  });
}

export async function flushPendingLocationStates() {
  let pending: PendingLocationState[] = [];
  await mutatePersistedSettings((current) => {
    const rules = rulesInCurrentTimeZone(parseLocationScheduleRules(current[RULES_FIELD]));
    pending = pendingLocationStatesForRules(current[PENDING_FIELD], rules);
    return { ...current, [PENDING_FIELD]: pending };
  });
  const sent = new Set<string>();
  for (const event of pending) {
    try {
      await runnerRequest("/location-schedules/state", "POST", event);
      sent.add(event.eventId);
    } catch (error) {
      if (error instanceof RunnerRequestError && (error.status === 400 || error.status === 404)) {
        sent.add(event.eventId);
        continue;
      }
      void logLocationScheduleEvent("location_state_flush_failed", {
        message: error instanceof Error ? error.message : String(error),
        pendingCount: pending.length,
        sentCount: sent.size,
      });
      break;
    }
  }
  if (!sent.size) return;
  await mutatePersistedSettings((current) => ({
    ...current,
    [PENDING_FIELD]: removeSentPendingLocationStates(current[PENDING_FIELD], sent),
  }));
}

export async function syncLocationSchedules(rules: readonly LocationScheduleRule[]) {
  const phoneTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  await runnerRequest("/location-schedules", "PUT", { phoneTimeZone, rules: rulesInCurrentTimeZone(rules) });
  await flushPendingLocationStates();
}

async function reconcileLocationRefreshTask(enabled: boolean) {
  try {
    if (enabled) {
      await BackgroundTask.registerTaskAsync(LOCATION_REFRESH_TASK_NAME, {
        minimumInterval: LOCATION_REFRESH_MINIMUM_INTERVAL_MINUTES,
      });
    } else {
      await BackgroundTask.unregisterTaskAsync(LOCATION_REFRESH_TASK_NAME);
    }
  } catch (error) {
    void logLocationScheduleEvent("location_refresh_task_register_failed", {
      enabled,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (enabled) {
      await Notifications.registerTaskAsync(LOCATION_PUSH_REFRESH_TASK_NAME);
    } else {
      await Notifications.unregisterTaskAsync(LOCATION_PUSH_REFRESH_TASK_NAME).catch(() => {});
    }
  } catch (error) {
    void logLocationScheduleEvent("location_push_refresh_task_register_failed", {
      enabled,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function reconcileLocationSchedules(rules: readonly LocationScheduleRule[]) {
  const regions = enabledLocationRegions(rules);
  if (!regions.length) {
    const running = await Location.hasStartedGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME).catch(() => false);
    if (running) await Location.stopGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME);
    await reconcileLocationRefreshTask(false);
    return;
  }
  let foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== "granted") foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") throw new Error("位置情報の使用中権限が必要です。");
  let background = await Location.getBackgroundPermissionsAsync();
  if (background.status !== "granted") background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") throw new Error("位置情報の「常に」権限が必要です。");
  // 監視中の再startはリージョン差し替えとして扱われる(expo公式)。stopを挟むと
  // 停止中の境界横断を取りこぼすため、startのみを呼ぶ。
  await Location.startGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME, regions);
  await reconcileLocationRefreshTask(true);

  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  for (const rule of rules.filter((item) => item.enabled)) {
    const state = isCoordinateInsideRule(current.coords, rule) ? "inside" : "outside";
    await persistLocationState({
      ruleId: rule.id,
      regionRevision: locationRuleRevision(rule),
      state,
      eventId: `initial:${rule.id}:${Date.now()}:${state}`,
      observedAt: new Date(current.timestamp || Date.now()).toISOString(),
    });
  }
  await flushPendingLocationStates();
}

export async function saveAndActivateLocationSchedules(rules: readonly LocationScheduleRule[]) {
  const normalized = rulesInCurrentTimeZone(rules);
  await mutatePersistedSettings((current) => ({
    ...current,
    [RULES_FIELD]: normalized,
    [PENDING_FIELD]: pendingLocationStatesForRules(current[PENDING_FIELD], normalized),
  }));
  await syncLocationSchedules(normalized);
  await reconcileLocationSchedules(normalized);
}

export async function loadLocationSchedules() {
  return rulesInCurrentTimeZone(parseLocationScheduleRules(await readPersistedSettingsField(RULES_FIELD)));
}

export async function recoverLocationScheduleState(origin: string) {
  await flushPendingLocationStates().catch(() => {});
  const rules = (await loadLocationSchedules()).filter((rule) => rule.enabled);
  if (!rules.length) return;
  const foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== "granted") return;
  const lastStatesRaw = await readPersistedSettingsField(LAST_STATES_FIELD);
  const lastStates = lastStatesRaw && typeof lastStatesRaw === "object" && !Array.isArray(lastStatesRaw)
    ? lastStatesRaw as Record<string, Partial<PendingLocationState> | undefined>
    : {};
  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  let changed = 0;
  for (const rule of rules) {
    const regionRevision = locationRuleRevision(rule);
    const state = isCoordinateInsideRule(current.coords, rule) ? "inside" : "outside";
    const last = lastStates[rule.id];
    if (last && last.regionRevision === regionRevision && last.state === state) continue;
    changed += 1;
    await persistLocationState({
      ruleId: rule.id,
      regionRevision,
      state,
      eventId: `recover:${origin}:${rule.id}:${Date.now()}:${state}`,
      observedAt: new Date(current.timestamp || Date.now()).toISOString(),
    });
  }
  void logLocationScheduleEvent("location_recover_ran", { origin, ruleCount: rules.length, changed });
  if (changed > 0) await flushPendingLocationStates();
}

let appStateRecoverySubscribed = false;
let lastAppState = AppState.currentState;

function subscribeAppStateRecovery() {
  if (appStateRecoverySubscribed) return;
  appStateRecoverySubscribed = true;
  AppState.addEventListener("change", (next) => {
    const previous = lastAppState;
    lastAppState = next;
    if (next !== "active" || previous === "active") return;
    void recoverLocationScheduleState("foreground").catch(() => {});
  });
}

export async function bootstrapLocationSchedules() {
  subscribeAppStateRecovery();
  const rules = await loadLocationSchedules();
  await mutatePersistedSettings((current) => ({
    ...current,
    [RULES_FIELD]: rules,
    [PENDING_FIELD]: pendingLocationStatesForRules(current[PENDING_FIELD], rules),
  }));
  if (!rules.some((rule) => rule.enabled)) {
    await reconcileLocationSchedules(rules);
    return;
  }
  const background = await Location.getBackgroundPermissionsAsync();
  if (background.status !== "granted") return;
  await syncLocationSchedules(rules).catch(() => {});
  await reconcileLocationSchedules(rules).catch(() => {});
}

if (!TaskManager.isTaskDefined(LOCATION_SCHEDULE_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_SCHEDULE_TASK_NAME, async ({ data, error }) => {
    if (error) {
      await logLocationScheduleEvent("location_geofence_task_error", {
        message: String(error.message || error),
      });
      return;
    }
    const payload = data as { eventType?: Location.GeofencingEventType; region?: { identifier?: string } } | undefined;
    const state = payload?.eventType === Location.GeofencingEventType.Enter
      ? "inside"
      : payload?.eventType === Location.GeofencingEventType.Exit
        ? "outside"
        : null;
    const region = parseLocationRegionIdentifier(payload?.region?.identifier);
    await logLocationScheduleEvent("location_geofence_task_fired", {
      identifier: String(payload?.region?.identifier || ""),
      state: state || "unknown",
      matchedRegion: Boolean(region),
    });
    if (!region) return;
    const rules = await loadLocationSchedules();
    const rule = rules.find((item) => item.enabled && item.id === region.ruleId);
    if (!rule || regionIdentifierForRule(rule) !== payload?.region?.identifier) {
      void logLocationScheduleEvent("location_geofence_event_ignored", {
        identifier: String(payload?.region?.identifier || ""),
        reason: rule ? "revision_mismatch" : "rule_not_found",
      });
      return;
    }
    if (!state) return;
    const event: PendingLocationState = {
      ruleId: region.ruleId,
      regionRevision: locationRuleRevision(rule),
      state,
      eventId: `geofence:${region.ruleId}:${region.regionRevision}:${Date.now()}:${state}`,
      observedAt: new Date().toISOString(),
    };
    await persistLocationState(event);
    await flushPendingLocationStates().catch(() => {});
  });
}

if (!TaskManager.isTaskDefined(LOCATION_PUSH_REFRESH_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_PUSH_REFRESH_TASK_NAME, async ({ data, error }) => {
    if (error) {
      await logLocationScheduleEvent("location_push_refresh_task_error", {
        message: String(error.message || error),
      });
      return;
    }
    // ペイロードの形はOS/ライブラリで揺れるため、マーカー文字列の有無で判定する
    if (!JSON.stringify(data ?? {}).includes(LOCATION_PUSH_REFRESH_MARKER)) return;
    await logLocationScheduleEvent("location_push_refresh_fired", {});
    await recoverLocationScheduleState("silent_push").catch((err) => {
      void logLocationScheduleEvent("location_push_refresh_task_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

if (!TaskManager.isTaskDefined(LOCATION_REFRESH_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_REFRESH_TASK_NAME, async () => {
    await logLocationScheduleEvent("location_refresh_task_fired", {});
    try {
      await recoverLocationScheduleState("background_task");
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      void logLocationScheduleEvent("location_refresh_task_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}
