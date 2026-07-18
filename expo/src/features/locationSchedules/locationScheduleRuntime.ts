import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

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

function rulesInCurrentTimeZone(rules: readonly LocationScheduleRule[]) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return rules.map((rule) => ({ ...rule, timeZone, regionRevision: locationRuleRevision(rule) }));
}

class RunnerRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function runnerRequest(path: string, method: "PUT" | "POST", body: Record<string, unknown>) {
  const runnerUrl = String(await readPersistedSettingsField("runnerUrl") || "").trim().replace(/\/+$/, "");
  const credentials = await loadSecureRunnerCredentials();
  if (!runnerUrl || !credentials.runnerToken) throw new Error("Runner connection is not configured");
  const response = await fetch(`${runnerUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.runnerToken}`,
      ...(credentials.cloudflareAccessClientId && credentials.cloudflareAccessClientSecret ? {
        "CF-Access-Client-Id": credentials.cloudflareAccessClientId,
        "CF-Access-Client-Secret": credentials.cloudflareAccessClientSecret,
      } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RunnerRequestError(String((result as any)?.message || `Runner HTTP ${response.status}`), response.status);
  }
  return result;
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

export async function reconcileLocationSchedules(rules: readonly LocationScheduleRule[]) {
  const regions = enabledLocationRegions(rules);
  const running = await Location.hasStartedGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME).catch(() => false);
  if (!regions.length) {
    if (running) await Location.stopGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME);
    return;
  }
  let foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== "granted") foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") throw new Error("位置情報の使用中権限が必要です。");
  let background = await Location.getBackgroundPermissionsAsync();
  if (background.status !== "granted") background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") throw new Error("位置情報の「常に」権限が必要です。");
  if (running) await Location.stopGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME);
  await Location.startGeofencingAsync(LOCATION_SCHEDULE_TASK_NAME, regions);

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

export async function bootstrapLocationSchedules() {
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
    if (error) return;
    const payload = data as { eventType?: Location.GeofencingEventType; region?: { identifier?: string } } | undefined;
    const region = parseLocationRegionIdentifier(payload?.region?.identifier);
    if (!region) return;
    const rules = await loadLocationSchedules();
    const rule = rules.find((item) => item.enabled && item.id === region.ruleId);
    if (!rule || regionIdentifierForRule(rule) !== payload?.region?.identifier) return;
    const state = payload?.eventType === Location.GeofencingEventType.Enter
      ? "inside"
      : payload?.eventType === Location.GeofencingEventType.Exit
        ? "outside"
        : null;
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
