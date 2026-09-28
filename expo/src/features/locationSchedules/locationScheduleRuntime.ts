import * as BackgroundTask from "expo-background-task";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";

import { mutatePersistedSettings, readPersistedSettingsField } from "../app/utils/persistedSettingsFile";
import { loadSecureRunnerCredentials } from "../app/utils/secureRunnerCredentials";
import { getOrCreatePushDeviceId } from "../app/utils/pushNotifications";
import {
  LOCATION_SCHEDULE_TASK_NAME,
  appendPendingLocationState,
  enabledLocationRegions,
  isCoordinateInsideRule,
  locationScheduleRevision,
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
const BACKGROUND_NOTIFICATION_TASK_NAME = "bitty-background-notification";

export function shouldRegisterBackgroundNotificationTask(
  rules: readonly LocationScheduleRule[]
) {
  return rules.some((rule) => rule.enabled);
}

function legacyRulesInCurrentTimeZone(rules: readonly LocationScheduleRule[], locationDeviceId: string) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return rules.map((rule) => {
    const current = { ...rule, timeZone, locationDeviceId };
    return {
      ...current,
      regionRevision: locationScheduleRevision(current),
    };
  });
}

function rulesWithRevisions(rules: readonly LocationScheduleRule[]) {
  return rules.map((rule) => ({ ...rule, regionRevision: locationScheduleRevision(rule) }));
}

function ownedRules(rules: readonly LocationScheduleRule[], deviceId: string) {
  return rules.filter((rule) => rule.locationDeviceId === deviceId);
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

async function runnerRequest(path: string, method: "GET" | "PUT" | "POST", body?: Record<string, unknown>) {
  const endpoint = await runnerEndpoint();
  if (!endpoint) throw new Error("Runner connection is not configured");
  const response = await fetch(`${endpoint.runnerUrl}${path}`, {
    method,
    headers: endpoint.headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
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
    const rules = parseLocationScheduleRules(current[RULES_FIELD]);
    pending = pendingLocationStatesForRules(current[PENDING_FIELD], rules);
    return { ...current, [PENDING_FIELD]: pending };
  });
  const sent = new Set<string>();
  if (!pending.length) return;
  const locationDeviceId = await getOrCreatePushDeviceId();
  for (const event of pending) {
    try {
      await runnerRequest("/location-schedules/state", "POST", { ...event, locationDeviceId });
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

async function fetchRunnerLocationSchedules() {
  const result = await runnerRequest("/location-schedules", "GET") as {
    snapshot: { scheduleRevision: number; rules: LocationScheduleRule[] };
  };
  return result.snapshot;
}

export async function syncLocationSchedules(rules: readonly LocationScheduleRule[], expectedRevision: number) {
  const phoneTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const result = await runnerRequest("/location-schedules", "PUT", {
    phoneTimeZone, rules: rulesWithRevisions(rules), expectedRevision,
  }) as { snapshot: { scheduleRevision: number } };
  await flushPendingLocationStates().catch(() => {});
  return result.snapshot.scheduleRevision;
}

async function reconcileLocationRefreshTask(enabled: boolean, rules: readonly LocationScheduleRule[] = []) {
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
    if (shouldRegisterBackgroundNotificationTask(rules)) {
      await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK_NAME);
    } else {
      await Notifications.unregisterTaskAsync(BACKGROUND_NOTIFICATION_TASK_NAME).catch(() => {});
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
    await reconcileLocationRefreshTask(false, rules);
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
  await reconcileLocationRefreshTask(true, rules);

  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  for (const rule of rules.filter((item) => item.enabled)) {
    const state = isCoordinateInsideRule(current.coords, rule) ? "inside" : "outside";
    await persistLocationState({
      ruleId: rule.id,
      regionRevision: locationScheduleRevision(rule),
      state,
      eventId: `initial:${rule.id}:${Date.now()}:${state}`,
      observedAt: new Date(current.timestamp || Date.now()).toISOString(),
    });
  }
  await flushPendingLocationStates();
}

export async function saveAndActivateLocationSchedules(rules: readonly LocationScheduleRule[], expectedRevision?: number) {
  const deviceId = await getOrCreatePushDeviceId();
  const normalized = rulesWithRevisions(rules);
  const revision = expectedRevision ?? (await fetchRunnerLocationSchedules()).scheduleRevision;
  await syncLocationSchedules(normalized, revision);
  const localRules = ownedRules(normalized, deviceId);
  await mutatePersistedSettings((current) => ({
    ...current,
    [RULES_FIELD]: localRules,
    [PENDING_FIELD]: pendingLocationStatesForRules(current[PENDING_FIELD], localRules),
  }));
  await reconcileLocationSchedules(localRules);
}

export async function loadLocationSchedules() {
  return parseLocationScheduleRules(await readPersistedSettingsField(RULES_FIELD));
}

export async function loadRunnerLocationSchedules() {
  const snapshot = await fetchRunnerLocationSchedules();
  const rules = parseLocationScheduleRules(snapshot.rules);
  const localRules = ownedRules(rules, await getOrCreatePushDeviceId());
  await mutatePersistedSettings((current) => ({
    ...current,
    [RULES_FIELD]: localRules,
    [PENDING_FIELD]: pendingLocationStatesForRules(current[PENDING_FIELD], localRules),
  }));
  return { rules, revision: snapshot.scheduleRevision };
}

export async function recoverLocationScheduleState(origin: string) {
  await flushPendingLocationStates().catch(() => {});
  const allRules = origin === "foreground" || origin === "silent_push"
    ? await loadRunnerLocationSchedules().then(() => loadLocationSchedules()).catch(() => loadLocationSchedules())
    : await loadLocationSchedules();
  if (origin === "foreground" || origin === "silent_push") {
    await reconcileLocationSchedules(allRules).catch(() => {});
  }
  const rules = allRules.filter((rule) => rule.enabled);
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
    const regionRevision = locationScheduleRevision(rule);
    const state = isCoordinateInsideRule(current.coords, rule) ? "inside" : "outside";
    const last = lastStates[rule.id];
    if (origin !== "silent_push"
      && last
      && last.regionRevision === regionRevision
      && last.state === state) continue;
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
  const localRules = await loadLocationSchedules();
  let rules: LocationScheduleRule[] = [];
  try {
    const deviceId = await getOrCreatePushDeviceId();
    const snapshot = await fetchRunnerLocationSchedules();
    if (snapshot.scheduleRevision === 0 && localRules.length > 0) {
      rules = legacyRulesInCurrentTimeZone(localRules, deviceId);
      await syncLocationSchedules(rules, 0);
    } else {
      const serverRules = parseLocationScheduleRules(snapshot.rules);
      const localIds = new Set(localRules.map((rule) => rule.id));
      const unowned = serverRules.filter((rule) => !rule.locationDeviceId && localIds.has(rule.id));
      if (unowned.length) {
        const claimed = serverRules.map((rule) => unowned.includes(rule) ? { ...rule, locationDeviceId: deviceId } : rule);
        await syncLocationSchedules(claimed, snapshot.scheduleRevision);
        rules = ownedRules(claimed, deviceId);
      } else {
        rules = ownedRules(serverRules, deviceId);
      }
    }
  } catch (error) {
    console.warn("[location-schedule] failed to load Runner schedules", error);
    rules = localRules;
  }
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
      regionRevision: region.regionRevision,
      state,
      eventId: `geofence:${region.ruleId}:${region.regionRevision}:${Date.now()}:${state}`,
      observedAt: new Date().toISOString(),
    };
    await persistLocationState(event);
    await flushPendingLocationStates().catch(() => {});
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
