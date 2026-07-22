import { isReasoningEffort, normalizeModelRef, type ReasoningEffort } from "../app/utils/settingsParsers";

export const MAX_ENABLED_LOCATION_SCHEDULES = 20;
export const DEFAULT_LOCATION_RADIUS_METERS = 200;
export const LOCATION_SCHEDULE_TASK_NAME = "bitty-location-schedule-geofence";
export const LOCATION_REGION_PREFIX = "bitty-ls:";

export type LocationScheduleRule = {
  id: string;
  enabled: boolean;
  startTime: string;
  endTime: string;
  timeZone: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  cwd: string;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
};

export type PendingLocationState = {
  ruleId: string;
  regionRevision: string;
  state: "inside" | "outside";
  eventId: string;
  observedAt: string;
};

function hashLocation(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function locationRuleRevision(
  rule: Pick<LocationScheduleRule, "latitude" | "longitude" | "radiusMeters">
) {
  return hashLocation(JSON.stringify([rule.latitude, rule.longitude, rule.radiusMeters]));
}

export function regionIdentifierForRule(rule: Pick<LocationScheduleRule, "id" | "latitude" | "longitude" | "radiusMeters">) {
  return `${LOCATION_REGION_PREFIX}${rule.id}:${locationRuleRevision(rule)}`;
}

function parseTime(raw: unknown) {
  const value = String(raw || "").trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return { value, minute: Number(match[1]) * 60 + Number(match[2]) };
}

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseLocationScheduleRules(
  raw: unknown,
  modelOptions?: readonly { value: string }[]
): LocationScheduleRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: LocationScheduleRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const id = String(value.id || "").trim();
    const start = parseTime(value.startTime);
    const end = parseTime(value.endTime);
    const timeZone = String(value.timeZone || "").trim();
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    const radiusMeters = Number(value.radiusMeters);
    const cwd = String(value.cwd || "").trim();
    const modelRef = normalizeModelRef(value.modelRef);
    const reasoningEffort = String(value.reasoningEffort || "").trim().toLowerCase();
    const prompt = String(value.prompt || "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || seen.has(id)) continue;
    if (!start || !end || end.minute <= start.minute) continue;
    if (!timeZone || !isTimeZone(timeZone)) continue;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) continue;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 100_000) continue;
    if (!cwd || !modelRef || !prompt || prompt.length > 24_000) continue;
    if (modelOptions && !modelOptions.some((option) => option.value === modelRef)) continue;
    if (!isReasoningEffort(reasoningEffort)) continue;
    seen.add(id);
    result.push({
      id,
      enabled: value.enabled === true,
      startTime: start.value,
      endTime: end.value,
      timeZone,
      latitude,
      longitude,
      radiusMeters,
      cwd,
      modelRef,
      reasoningEffort,
      prompt,
    });
  }
  return result;
}

export function enabledLocationRegions(rules: readonly LocationScheduleRule[]) {
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length > MAX_ENABLED_LOCATION_SCHEDULES) {
    throw new Error(`有効な位置ルールは${MAX_ENABLED_LOCATION_SCHEDULES}件までです。`);
  }
  return enabled.map((rule) => ({
    identifier: regionIdentifierForRule(rule),
    latitude: rule.latitude,
    longitude: rule.longitude,
    radius: rule.radiusMeters,
    notifyOnEnter: true,
    notifyOnExit: true,
  }));
}

export function parseLocationRegionIdentifier(identifier: unknown) {
  const value = String(identifier || "");
  if (!value.startsWith(LOCATION_REGION_PREFIX)) return null;
  const separator = value.lastIndexOf(":");
  const ruleId = value.slice(LOCATION_REGION_PREFIX.length, separator);
  const regionRevision = value.slice(separator + 1);
  if (!ruleId || !/^[a-f0-9]{16}$/.test(regionRevision)) return null;
  return { ruleId, regionRevision };
}

export function isCoordinateInsideRule(
  coordinate: { latitude: number; longitude: number },
  rule: Pick<LocationScheduleRule, "latitude" | "longitude" | "radiusMeters">
) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(coordinate.latitude - rule.latitude);
  const dLon = radians(coordinate.longitude - rule.longitude);
  const lat1 = radians(rule.latitude);
  const lat2 = radians(coordinate.latitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= rule.radiusMeters;
}

export function appendPendingLocationState(
  current: unknown,
  event: PendingLocationState
): PendingLocationState[] {
  const pending = parsePendingLocationStates(current);
  return appendParsedPendingLocationState(pending, event);
}

function appendParsedPendingLocationState(pending: PendingLocationState[], event: PendingLocationState) {
  if (pending.some((item) => item.eventId === event.eventId)) return pending;
  const previous = pending.find((item) => item.ruleId === event.ruleId);
  if (previous && Date.parse(previous.observedAt) > Date.parse(event.observedAt)) return pending;
  return [...pending.filter((item) => item.ruleId !== event.ruleId), event].slice(-200);
}

export function parsePendingLocationStates(current: unknown): PendingLocationState[] {
  if (!Array.isArray(current)) return [];
  return current.reduce<PendingLocationState[]>((pending, item) => {
    if (
      !item || typeof item !== "object" ||
      typeof item.ruleId !== "string" ||
      typeof item.regionRevision !== "string" ||
      typeof item.eventId !== "string" ||
      typeof item.observedAt !== "string" ||
      (item.state !== "inside" && item.state !== "outside")
    ) return pending;
    return appendParsedPendingLocationState(pending, item as PendingLocationState);
  }, []);
}

export function pendingLocationStatesForRules(current: unknown, rules: readonly LocationScheduleRule[]) {
  const revisions = new Map(
    rules.filter((rule) => rule.enabled).map((rule) => [rule.id, locationRuleRevision(rule)])
  );
  return parsePendingLocationStates(current).filter((event) => revisions.get(event.ruleId) === event.regionRevision);
}

export function removeSentPendingLocationStates(current: unknown, sentEventIds: ReadonlySet<string>) {
  return parsePendingLocationStates(current).filter((event) => !sentEventIds.has(event.eventId));
}
