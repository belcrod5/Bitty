import * as TaskManager from "expo-task-manager";
import { getOrCreatePushDeviceId } from "./pushNotifications";
import { readPersistedSettings } from "./persistedSettingsFile";
import { loadSecureRunnerCredentials } from "./secureRunnerCredentials";
import { getCalendarPermission, getEvent, listCalendars, searchEvents } from "../../calendar/calendarService";
import { parseLocationScheduleRules, locationScheduleRevision } from "../../locationSchedules/locationScheduleRules";
import { recoverLocationScheduleState } from "../../locationSchedules/locationScheduleRuntime";

export const BACKGROUND_NOTIFICATION_TASK = "bitty-background-notification";
const CALENDAR_MARKER = "calendar_request_available";
const LOCATION_MARKER = "location_state_refresh";
const REQUEST_TIMEOUT_MS = 5_000;
const TASK_TIMEOUT_MS = 18_000;
const MAX_REQUESTS_PER_WAKE = 3;

async function fetchBeforeDeadline(url: string, init: RequestInit, deadline: AbortSignal) {
  if (deadline.aborted) throw new Error("background task deadline exceeded");
  const controller = new AbortController();
  const onDeadline = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  deadline.addEventListener("abort", onDeadline, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    deadline.removeEventListener("abort", onDeadline);
  }
}

export async function processCalendarRequests() {
  const settings = await readPersistedSettings();
  const runnerUrl = String(settings?.runnerUrl || "").replace(/\/$/, "");
  const credentials = await loadSecureRunnerCredentials();
  if (!runnerUrl || !credentials.runnerToken) return;
  const deviceId = await getOrCreatePushDeviceId();
  const headers = { "content-type": "application/json", authorization: `Bearer ${credentials.runnerToken}` };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
  try {
    const response = await fetchBeforeDeadline(`${runnerUrl}/calendar/requests?deviceId=${encodeURIComponent(deviceId)}`, { headers }, controller.signal);
    const requests = response.ok ? (await response.json()).requests : [];
    for (const request of Array.isArray(requests) ? requests.slice(0, MAX_REQUESTS_PER_WAKE) : []) {
      if (controller.signal.aborted || Date.parse(String(request.expiresAt)) <= Date.now()) break;
      const live = await readPersistedSettings();
      const rule = parseLocationScheduleRules(live?.locationSchedules).find((item) =>
        item.id === request.ruleId && item.enabled && item.calendarAccess === "read"
          && item.calendarDeviceId === deviceId && locationScheduleRevision(item) === request.ruleRevision);
      if (!rule) continue;
      const permission = await getCalendarPermission();
      if (!permission.ok) continue;
      const result = request.tool === "calendar_list_calendars" ? await listCalendars()
        : request.tool === "calendar_search_events" ? await searchEvents(request.arguments)
          : request.tool === "calendar_get_event" ? await getEvent(request.arguments)
            : null;
      if (!result) continue;
      const beforePost = await readPersistedSettings();
      const currentRule = parseLocationScheduleRules(beforePost?.locationSchedules).find((item) => item.id === request.ruleId);
      if (!currentRule || !currentRule.enabled
        || currentRule.calendarAccess !== "read" || currentRule.calendarDeviceId !== deviceId
        || locationScheduleRevision(currentRule) !== request.ruleRevision) continue;
      await fetchBeforeDeadline(`${runnerUrl}/calendar/requests/${encodeURIComponent(String(request.requestId))}/result`, {
        method: "POST", headers,
        body: JSON.stringify({ deviceId, requestHash: request.requestHash, result }),
      }, controller.signal);
    }
  } catch {
    // Silent push is best-effort and never retried as the same Codex turn.
  } finally {
    clearTimeout(deadline);
  }
}

export async function dispatchBackgroundNotification(data: unknown) {
  const serialized = JSON.stringify(data ?? {});
  if (serialized.includes(CALENDAR_MARKER)) return processCalendarRequests();
  if (serialized.includes(LOCATION_MARKER)) return recoverLocationScheduleState("silent_push").catch(() => {});
}

if (!TaskManager.isTaskDefined(BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, ({ data }) => dispatchBackgroundNotification(data));
}
