const mockMutatePersistedSettings = jest.fn();
const mockReadPersistedSettingsField = jest.fn();
const mockReadPersistedSettings = jest.fn();
const mockFreezeLegacyRunnerUrls = jest.fn();
const mockLoadSecureRunnerCredentials = jest.fn();
const mockFetch = jest.fn();
const mockGetForegroundPermissionsAsync = jest.fn();
const mockGetBackgroundPermissionsAsync = jest.fn();
const mockGetCurrentPositionAsync = jest.fn();
const mockHasStartedGeofencingAsync = jest.fn();
const mockStopGeofencingAsync = jest.fn();
const mockStartGeofencingAsync = jest.fn();
let mockSettings: Record<string, unknown> = {};
let mockRunnerRules: LocationScheduleRule[] = [];
let mockRunnerConflicts: LocationScheduleRule[] = [];
let mockRunnerRevision = 0;
let mockTimeZone = "Asia/Tokyo";
let mockRunnerUrl = "http://runner.test";
let mockOriginalRunnerUrls = ["http://runner.test"];

jest.mock("../app/utils/persistedSettingsFile", () => ({
  configuredRunnerUrls: (settings: Record<string, unknown>) => [settings.runnerUrl, settings.localRunnerUrl, settings.cloudflareRunnerUrl]
    .filter((value): value is string => typeof value === "string"),
  freezeLegacyRunnerUrls: () => mockFreezeLegacyRunnerUrls(),
  legacyRunnerUrls: (settings: Record<string, unknown>) => Array.isArray(settings.legacyRunnerUrls) ? settings.legacyRunnerUrls : [],
  mutatePersistedSettings: (mutate: (current: Record<string, unknown>) => Record<string, unknown>) => (
    mockMutatePersistedSettings(mutate)
  ),
  readPersistedSettings: () => mockReadPersistedSettings(),
  readPersistedSettingsField: (field: string) => mockReadPersistedSettingsField(field),
}));

jest.mock("../app/utils/secureRunnerCredentials", () => ({
  loadSecureRunnerCredentials: () => mockLoadSecureRunnerCredentials(),
}));

jest.mock("../app/utils/pushNotifications", () => ({
  getOrCreatePushDeviceId: async () => "device-1",
}));

jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: "success", Failed: "failed" },
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: "balanced" },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  getForegroundPermissionsAsync: () => mockGetForegroundPermissionsAsync(),
  requestForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: () => mockGetBackgroundPermissionsAsync(),
  requestBackgroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: () => mockGetCurrentPositionAsync(),
  hasStartedGeofencingAsync: () => mockHasStartedGeofencingAsync(),
  stopGeofencingAsync: () => mockStopGeofencingAsync(),
  startGeofencingAsync: (...args: unknown[]) => mockStartGeofencingAsync(...args),
}));

jest.mock("expo-notifications", () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock("expo-task-manager", () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
}));

jest.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: jest.fn() },
  Platform: { OS: "ios", Version: "test" },
}));

import {
  bootstrapLocationSchedules,
  loadRunnerLocationSchedules,
  recoverLocationScheduleState,
  saveAndActivateLocationSchedules,
  shouldRegisterBackgroundNotificationTask,
} from "./locationScheduleRuntime";
import {
  LOCATION_SCHEDULE_TASK_NAME,
  locationScheduleRevision,
  regionIdentifierForRule,
  type LocationScheduleRule,
} from "./locationScheduleRules";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";

const mockLocationScheduleTaskCallback = (TaskManager.defineTask as jest.Mock).mock.calls.find(
  ([taskName]) => taskName === LOCATION_SCHEDULE_TASK_NAME,
)?.[1];

function rule(overrides: Partial<LocationScheduleRule> = {}): LocationScheduleRule {
  return {
    id: "office",
    enabled: true,
    startTime: "09:00",
    endTime: "10:00",
    timeZone: "Asia/Tokyo",
    latitude: 35.6812,
    longitude: 139.7671,
    radiusMeters: 200,
    cwd: "/work/project",
    modelRef: "gpt-5.6-sol",
    reasoningEffort: "high",
    prompt: "run checks",
    locationDeviceId: "device-1",
    ...overrides,
  };
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({}) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings = {};
  mockRunnerRules = [];
  mockRunnerConflicts = [];
  mockRunnerRevision = 0;
  mockTimeZone = "Asia/Tokyo";
  mockRunnerUrl = "http://runner.test";
  mockOriginalRunnerUrls = ["http://runner.test"];
  mockMutatePersistedSettings.mockImplementation(async (mutate) => {
    mockSettings = mutate({ runnerUrl: mockRunnerUrl, ...mockSettings });
  });
  mockReadPersistedSettings.mockImplementation(async () => ({ runnerUrl: mockRunnerUrl, ...mockSettings }));
  mockFreezeLegacyRunnerUrls.mockImplementation(async () => {
    if (!Object.prototype.hasOwnProperty.call(mockSettings, "legacyRunnerUrls")) {
      mockSettings.legacyRunnerUrls = [...mockOriginalRunnerUrls];
    }
  });
  mockReadPersistedSettingsField.mockImplementation(async (field) => (
    field === "runnerUrl" ? mockRunnerUrl : mockSettings[field]
  ));
  mockLoadSecureRunnerCredentials.mockResolvedValue({ runnerToken: "token" });
  mockFetch.mockImplementation(async (url, options) => {
    if (String(url).endsWith("/location-schedules")) {
      if (options?.method === "PUT") {
        const body = JSON.parse(String(options.body));
        if (body.expectedRevision !== mockRunnerRevision) {
          return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
        }
        mockRunnerRules = body.rules;
        for (const conflict of body.migrationConflicts || []) {
          if (!mockRunnerConflicts.some((stored) => JSON.stringify(stored) === JSON.stringify(conflict))) {
            mockRunnerConflicts.push(conflict);
          }
        }
        mockRunnerRevision += 1;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: {
        scheduleRevision: mockRunnerRevision, rules: mockRunnerRules, migrationConflicts: mockRunnerConflicts,
      } }) };
    }
    return okResponse();
  });
  global.fetch = mockFetch as typeof fetch;
  mockGetForegroundPermissionsAsync.mockResolvedValue({ status: "granted" });
  mockGetBackgroundPermissionsAsync.mockResolvedValue({ status: "granted" });
  mockGetCurrentPositionAsync.mockResolvedValue({
    coords: { latitude: 35.6812, longitude: 139.7671 },
    timestamp: Date.parse("2026-07-19T00:00:00Z"),
  });
  mockHasStartedGeofencingAsync.mockResolvedValue(false);
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function resolvedOptions() {
    return { locale: "en-US", calendar: "gregory", numberingSystem: "latn", timeZone: mockTimeZone };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("uses the shared notification task while either background feature is active", async () => {
  const currentRule = rule();

  expect(shouldRegisterBackgroundNotificationTask([])).toBe(false);
  expect(shouldRegisterBackgroundNotificationTask([currentRule])).toBe(true);

  await saveAndActivateLocationSchedules([currentRule]);
  expect(Notifications.registerTaskAsync).toHaveBeenCalledWith("bitty-background-notification");

  await saveAndActivateLocationSchedules([{ ...currentRule, enabled: false, calendarAccess: "none", calendarDeviceId: null }]);
  expect(Notifications.unregisterTaskAsync).toHaveBeenCalledWith("bitty-background-notification");
});

test("restores local schedules when Runner synchronization fails", async () => {
  const previous = rule();
  mockSettings = { locationSchedules: [previous], locationSchedulePendingStates: [{ eventId: "pending" }] };
  mockFetch.mockRejectedValueOnce(new Error("offline"));

  await expect(saveAndActivateLocationSchedules([{ ...previous, enabled: false }])).rejects.toThrow("offline");

  expect(mockSettings.locationSchedules).toEqual([previous]);
  expect(mockSettings.locationSchedulePendingStates).toEqual([{ eventId: "pending" }]);
});

test("a stale editor cannot overwrite a newer Runner schedule", async () => {
  mockRunnerRules = [rule({ prompt: "newer" })];
  mockRunnerRevision = 2;
  await expect(saveAndActivateLocationSchedules([rule({ prompt: "stale" })], 1)).rejects.toThrow("conflict");
  expect(mockRunnerRules[0].prompt).toBe("newer");
  expect(mockSettings.locationSchedules).toBeUndefined();
});

test("saving reports current state with the accepted rule revision", async () => {
  const currentRule = rule({ startTime: "08:00", prompt: "edited" });

  await saveAndActivateLocationSchedules([currentRule]);

  const scheduleIndex = mockFetch.mock.calls.findIndex(([url, options]) => String(url).endsWith("/location-schedules") && options?.method === "PUT");
  const stateIndex = mockFetch.mock.calls.findIndex(([url]) => String(url).endsWith("/location-schedules/state"));
  const schedule = JSON.parse(String(mockFetch.mock.calls[scheduleIndex]?.[1]?.body));
  const state = JSON.parse(String(mockFetch.mock.calls[stateIndex]?.[1]?.body));
  expect(scheduleIndex).toBeGreaterThanOrEqual(0);
  expect(stateIndex).toBeGreaterThan(scheduleIndex);
  expect(state.regionRevision).toBe(schedule.rules[0].regionRevision);
  expect(state.state).toBe("inside");
});

test("an enter from the previous geofence generation is ignored before current-state sync", async () => {
  const previous = rule();
  const edited = rule({ prompt: "edited" });
  mockSettings = { locationSchedules: [previous] };
  let resolveCurrentPosition!: (value: unknown) => void;
  mockGetCurrentPositionAsync.mockReturnValue(new Promise((resolve) => {
    resolveCurrentPosition = resolve;
  }));

  const saving = saveAndActivateLocationSchedules([edited]);
  for (let index = 0; index < 1000 && mockGetCurrentPositionAsync.mock.calls.length === 0; index += 1) {
    await Promise.resolve();
  }
  expect(mockGetCurrentPositionAsync).toHaveBeenCalledTimes(1);
  const callback = mockLocationScheduleTaskCallback;
  expect(callback).toBeDefined();
  await callback?.({
    data: {
      eventType: 1,
      region: { identifier: regionIdentifierForRule(previous) },
    },
  });
  expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/location-schedules/state"))).toHaveLength(0);

  resolveCurrentPosition({
    coords: { latitude: edited.latitude, longitude: edited.longitude },
    timestamp: Date.parse("2026-07-19T00:00:00Z"),
  });
  await saving;
  const stateRequests = mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/location-schedules/state"));
  expect(stateRequests).toHaveLength(1);
  expect(JSON.parse(String(stateRequests[0][1]?.body)).regionRevision).toBe(locationScheduleRevision(edited));
});

test.each([
  { rules: [] as LocationScheduleRule[], backgroundStatus: "granted" },
  { rules: [rule()], backgroundStatus: "denied" },
])("bootstrap only migrates unsynced local rules before permission-dependent setup", async ({ rules, backgroundStatus }) => {
  mockSettings = { locationSchedules: rules };
  mockGetBackgroundPermissionsAsync.mockResolvedValue({ status: backgroundStatus });

  await bootstrapLocationSchedules();

  const writes = mockFetch.mock.calls.filter(([url, options]) => String(url).endsWith("/location-schedules") && options?.method === "PUT");
  expect(writes).toHaveLength(rules.length ? 1 : 0);
  if (rules.length) expect(JSON.parse(String(writes[0]?.[1]?.body)).rules).toHaveLength(rules.length);
});

test("silent push reports a fresh state even when inside/outside did not change", async () => {
  const currentRule = rule();
  mockRunnerRules = [currentRule];
  mockSettings = {
    locationSchedules: [currentRule],
    locationScheduleLastStates: {
      office: {
        ruleId: "office",
        regionRevision: locationScheduleRevision(currentRule),
        state: "inside",
        eventId: "old",
        observedAt: "2026-07-18T00:00:00Z",
      },
    },
  };

  await recoverLocationScheduleState("silent_push");

  expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/location-schedules/state"))).toBe(true);
});

test("another device's rules are visible but never geofenced or reported by this device", async () => {
  mockRunnerRules = [rule({ locationDeviceId: "device-2" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();
  await recoverLocationScheduleState("silent_push");

  expect(mockSettings.locationSchedules).toEqual([]);
  expect(mockStartGeofencingAsync).not.toHaveBeenCalled();
  expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/location-schedules/state"))).toBe(false);
});

test("editing another device's rule preserves its schedule timezone and owner", async () => {
  const foreign = rule({ locationDeviceId: "device-2", timeZone: "America/New_York", prompt: "edited remotely" });
  mockRunnerRevision = 1;

  await saveAndActivateLocationSchedules([foreign], 1);

  expect(mockRunnerRules[0]).toMatchObject({
    locationDeviceId: "device-2", timeZone: "America/New_York", prompt: "edited remotely",
  });
  expect(mockSettings.locationSchedules).toEqual([]);
  expect(mockStartGeofencingAsync).not.toHaveBeenCalled();
});

test("foreground recovery reads Runner without overwriting it from stale local rules", async () => {
  mockSettings = { locationSchedules: [rule()], locationScheduleMigrationComplete: true };
  mockTimeZone = "America/New_York";

  await recoverLocationScheduleState("foreground");

  expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/location-schedules"))).toBe(true);
  expect(mockFetch.mock.calls.some(([url, options]) => String(url).endsWith("/location-schedules") && options?.method === "PUT")).toBe(false);
  expect(mockSettings.locationSchedules).toEqual([]);
});

test("migrates a second device's missing legacy rule without replacing Runner rules", async () => {
  mockSettings = { locationSchedules: [rule({ id: "legacy-local" })] };
  mockRunnerRules = [rule({ id: "runner-existing", locationDeviceId: "device-2" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();

  expect(mockRunnerRules.map((item) => item.id)).toEqual(["runner-existing", "legacy-local"]);
  expect(mockSettings.locationSchedules).toEqual([expect.objectContaining({ id: "legacy-local", locationDeviceId: "device-1" })]);
  expect(mockSettings.locationScheduleMigrationComplete).toBe(true);
});

test("preserves a differing old device rule on Runner while its current rule wins", async () => {
  mockSettings = { locationSchedules: [rule({ prompt: "old device" })] };
  mockRunnerRules = [rule({ prompt: "current" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();

  expect(mockRunnerRules[0].prompt).toBe("current");
  expect(mockRunnerConflicts[0].prompt).toBe("old device");
  expect(mockSettings.locationScheduleMigrationComplete).toBe(true);
  expect(mockSettings.locationSchedules).toEqual([expect.objectContaining({ prompt: "current" })]);
});

test("an offline legacy rule stays on its frozen Runner after the selected URL changes", async () => {
  const legacy = rule({ id: "old-runner-only" });
  mockSettings = { locationSchedules: [legacy] };
  mockOriginalRunnerUrls = ["http://old-runner.test"];
  mockRunnerUrl = "http://old-runner.test";
  mockFetch.mockRejectedValueOnce(new Error("offline"));
  await bootstrapLocationSchedules();
  expect(mockSettings.legacyRunnerUrls).toEqual(["http://old-runner.test"]);

  mockRunnerUrl = "http://new-runner.test";
  await bootstrapLocationSchedules();
  expect(mockFetch.mock.calls.filter(([url, options]) => String(url).startsWith("http://new-runner.test/") && options?.method === "PUT")).toHaveLength(0);
  expect(mockSettings.locationSchedules).toEqual([legacy]);
  expect(mockSettings.locationScheduleMigrationComplete).toBeUndefined();
  expect(mockStartGeofencingAsync).not.toHaveBeenCalled();
});

test("a configured Cloudflare route can migrate rules owned by the same Runner", async () => {
  mockSettings = { locationSchedules: [rule()], localRunnerUrl: "http://old.local", cloudflareRunnerUrl: "https://old.example.com" };
  mockOriginalRunnerUrls = ["http://old.local", "https://old.example.com"];
  mockRunnerUrl = "https://old.example.com";

  await bootstrapLocationSchedules();

  expect(mockFetch.mock.calls.filter(([url, options]) => String(url).startsWith("https://old.example.com/") && options?.method === "PUT")).toHaveLength(1);
  expect(mockSettings.locationScheduleMigrationComplete).toBe(true);
});

test("pending location events remain local when switched to another Runner", async () => {
  const pending = { ruleId: "office", regionRevision: locationScheduleRevision(rule()),
    state: "inside", eventId: "pending-old", observedAt: "2026-07-19T00:00:00Z" };
  mockSettings = {
    locationSchedules: [rule()], locationScheduleMigrationComplete: true,
    locationScheduleRunnerUrls: ["http://old-runner.test"],
    locationSchedulePendingStates: [pending],
  };
  mockRunnerUrl = "http://new-runner.test";

  await bootstrapLocationSchedules();

  expect(mockSettings.locationSchedulePendingStates).toEqual([pending]);
  expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/location-schedules/state"))).toHaveLength(0);
  expect(mockStartGeofencingAsync).not.toHaveBeenCalled();
});

test("preserves a legacy rule when its id collides with a different owner's rule", async () => {
  mockSettings = { locationSchedules: [rule({ prompt: "local schedule" })] };
  mockRunnerRules = [rule({ locationDeviceId: "device-2", prompt: "different schedule" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();

  expect(mockRunnerRules).toHaveLength(2);
  expect(mockRunnerRules[0]).toMatchObject({ id: "office", locationDeviceId: "device-2" });
  expect(mockRunnerRules[1].id).toMatch(/^legacy_/);
  expect(mockSettings.locationSchedules).toEqual([expect.objectContaining({
    id: mockRunnerRules[1].id, prompt: "local schedule", locationDeviceId: "device-1",
  })]);
});

test("same-named rules from different devices both survive migration", async () => {
  mockSettings = { locationSchedules: [rule()] };
  mockRunnerRules = [rule({ locationDeviceId: "device-2" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();

  expect(mockRunnerRules).toHaveLength(2);
  expect(mockRunnerRules.map((item) => item.locationDeviceId)).toEqual(["device-2", "device-1"]);
  expect(mockRunnerRules[1].id).toMatch(/^legacy_/);
});

test("a locally cached calendar-only rule is not claimed by the wrong location device", async () => {
  mockSettings = { locationSchedules: [rule({ locationDeviceId: "device-2", calendarAccess: "read", calendarDeviceId: "device-1" })] };
  mockRunnerRules = [];

  await bootstrapLocationSchedules();

  expect(mockRunnerRules).toEqual([]);
  expect(mockSettings.locationSchedules).toEqual([]);
});

test("retrying a partially completed migration does not duplicate a colliding rule", async () => {
  mockSettings = { locationSchedules: [rule({ prompt: "local schedule" })] };
  mockRunnerRules = [rule({ locationDeviceId: "device-2" })];
  mockRunnerRevision = 1;
  const respond = mockFetch.getMockImplementation()!;
  let reads = 0;
  mockFetch.mockImplementation(async (url, options) => {
    if (String(url).endsWith("/location-schedules") && options?.method === "GET" && ++reads === 2) {
      throw new Error("connection dropped after migration write");
    }
    return respond(url, options);
  });

  await expect(loadRunnerLocationSchedules()).rejects.toThrow("connection dropped");
  expect(mockRunnerRules).toHaveLength(2);
  await loadRunnerLocationSchedules();
  expect(mockRunnerRules).toHaveLength(2);
  expect(mockSettings.locationScheduleMigrationComplete).toBe(true);
});

test("retains another location owner's calendar rule for this device's push verification", async () => {
  mockRunnerRules = [rule({ locationDeviceId: "device-2", calendarAccess: "read", calendarDeviceId: "device-1" })];
  mockRunnerRevision = 1;

  await bootstrapLocationSchedules();

  expect(mockSettings.locationSchedules).toEqual([expect.objectContaining({ calendarDeviceId: "device-1" })]);
  expect(mockStartGeofencingAsync).not.toHaveBeenCalled();
  expect(Notifications.registerTaskAsync).toHaveBeenCalledWith("bitty-background-notification");
});
