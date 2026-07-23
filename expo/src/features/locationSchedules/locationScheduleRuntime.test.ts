const mockMutatePersistedSettings = jest.fn();
const mockReadPersistedSettingsField = jest.fn();
const mockLoadSecureRunnerCredentials = jest.fn();
const mockFetch = jest.fn();
const mockGetForegroundPermissionsAsync = jest.fn();
const mockGetBackgroundPermissionsAsync = jest.fn();
const mockGetCurrentPositionAsync = jest.fn();
const mockHasStartedGeofencingAsync = jest.fn();
const mockStopGeofencingAsync = jest.fn();
const mockStartGeofencingAsync = jest.fn();
let mockSettings: Record<string, unknown> = {};
let mockTimeZone = "Asia/Tokyo";

jest.mock("../app/utils/persistedSettingsFile", () => ({
  mutatePersistedSettings: (mutate: (current: Record<string, unknown>) => Record<string, unknown>) => (
    mockMutatePersistedSettings(mutate)
  ),
  readPersistedSettingsField: (field: string) => mockReadPersistedSettingsField(field),
}));

jest.mock("../app/utils/secureRunnerCredentials", () => ({
  loadSecureRunnerCredentials: () => mockLoadSecureRunnerCredentials(),
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
  recoverLocationScheduleState,
  saveAndActivateLocationSchedules,
} from "./locationScheduleRuntime";
import { locationRuleRevision, scheduleRuleRevision, type LocationScheduleRule } from "./locationScheduleRules";

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
    ...overrides,
  };
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({}) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings = {};
  mockTimeZone = "Asia/Tokyo";
  mockMutatePersistedSettings.mockImplementation(async (mutate) => {
    mockSettings = mutate(mockSettings);
  });
  mockReadPersistedSettingsField.mockImplementation(async (field) => (
    field === "runnerUrl" ? "http://runner.test" : mockSettings[field]
  ));
  mockLoadSecureRunnerCredentials.mockResolvedValue({ runnerToken: "token" });
  mockFetch.mockResolvedValue(okResponse());
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

test("restores local schedules when Runner synchronization fails", async () => {
  const previous = rule();
  mockSettings = { locationSchedules: [previous], locationSchedulePendingStates: [{ eventId: "pending" }] };
  mockFetch.mockRejectedValueOnce(new Error("offline"));

  await expect(saveAndActivateLocationSchedules([{ ...previous, enabled: false }])).rejects.toThrow("offline");

  expect(mockSettings.locationSchedules).toEqual([previous]);
  expect(mockSettings.locationSchedulePendingStates).toEqual([{ eventId: "pending" }]);
});

test("saving reports current state with the accepted schedule revision", async () => {
  const currentRule = rule({ startTime: "08:00", prompt: "edited" });

  await saveAndActivateLocationSchedules([currentRule]);

  const scheduleIndex = mockFetch.mock.calls.findIndex(([url]) => String(url).endsWith("/location-schedules"));
  const stateIndex = mockFetch.mock.calls.findIndex(([url]) => String(url).endsWith("/location-schedules/state"));
  const schedule = JSON.parse(String(mockFetch.mock.calls[scheduleIndex]?.[1]?.body));
  const state = JSON.parse(String(mockFetch.mock.calls[stateIndex]?.[1]?.body));
  expect(scheduleIndex).toBeGreaterThanOrEqual(0);
  expect(stateIndex).toBeGreaterThan(scheduleIndex);
  expect(state.scheduleRevision).toBe(schedule.rules[0].scheduleRevision);
  expect(state.state).toBe("inside");
});

test.each([
  { rules: [] as LocationScheduleRule[], backgroundStatus: "granted" },
  { rules: [rule()], backgroundStatus: "denied" },
])("bootstrap synchronizes the complete rule set before permission-dependent setup", async ({ rules, backgroundStatus }) => {
  mockSettings = { locationSchedules: rules };
  mockGetBackgroundPermissionsAsync.mockResolvedValue({ status: backgroundStatus });

  await bootstrapLocationSchedules();

  const request = mockFetch.mock.calls.find(([url]) => String(url).endsWith("/location-schedules"));
  expect(request).toBeDefined();
  expect(JSON.parse(String(request?.[1]?.body)).rules).toHaveLength(rules.length);
});

test("silent push reports a fresh state even when inside/outside did not change", async () => {
  const currentRule = rule();
  mockSettings = {
    locationSchedules: [currentRule],
    locationScheduleLastStates: {
      office: {
        ruleId: "office",
        regionRevision: locationRuleRevision(currentRule),
        scheduleRevision: scheduleRuleRevision(currentRule),
        state: "inside",
        eventId: "old",
        observedAt: "2026-07-18T00:00:00Z",
      },
    },
  };

  await recoverLocationScheduleState("silent_push");

  expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/location-schedules/state"))).toBe(true);
});

test("foreground recovery synchronizes and persists a changed phone timezone", async () => {
  mockSettings = { locationSchedules: [rule()] };
  mockTimeZone = "America/New_York";

  await recoverLocationScheduleState("foreground");

  expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/location-schedules"))).toBe(true);
  expect((mockSettings.locationSchedules as LocationScheduleRule[])[0].timeZone).toBe("America/New_York");
});
