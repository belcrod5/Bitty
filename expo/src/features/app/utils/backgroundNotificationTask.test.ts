const mockFetch = jest.fn();
const mockReadPersistedSettings = jest.fn();
const mockSecureStoreGet = jest.fn();
const mockRecoverLocationScheduleState = jest.fn();
const mockGetCalendarPermission = jest.fn();
const mockListCalendars = jest.fn();
const mockSearchEvents = jest.fn();
const mockGetEvent = jest.fn();

jest.mock("expo-task-manager", () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
}));

jest.mock("expo-notifications", () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "after_first_unlock",
  getItemAsync: (...args: unknown[]) => mockSecureStoreGet(...args),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "generated") }));

jest.mock("./persistedSettingsFile", () => ({
  readPersistedSettings: () => mockReadPersistedSettings(),
}));

jest.mock("../../calendar/calendarService", () => ({
  getCalendarPermission: (...args: unknown[]) => mockGetCalendarPermission(...args),
  listCalendars: (...args: unknown[]) => mockListCalendars(...args),
  searchEvents: (...args: unknown[]) => mockSearchEvents(...args),
  getEvent: (...args: unknown[]) => mockGetEvent(...args),
}));

jest.mock("../../locationSchedules/locationScheduleRuntime", () => ({
  recoverLocationScheduleState: (...args: unknown[]) => mockRecoverLocationScheduleState(...args),
}));

import * as TaskManager from "expo-task-manager";
import {
  BACKGROUND_NOTIFICATION_TASK,
  dispatchBackgroundNotification,
  processCalendarRequests,
} from "./backgroundNotificationTask";
import { locationScheduleRevision, type LocationScheduleRule } from "../../locationSchedules/locationScheduleRules";

const backgroundTaskCallback = (TaskManager.defineTask as jest.Mock).mock.calls.find(
  ([name]) => name === BACKGROUND_NOTIFICATION_TASK,
)?.[1];

function rule(overrides: Partial<LocationScheduleRule> = {}): LocationScheduleRule {
  return {
    id: "rule-1",
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
    prompt: "check calendar",
    calendarAccess: "read",
    calendarDeviceId: "device-1",
    ...overrides,
  };
}

function settings(currentRule = rule()) {
  return {
    runnerUrl: "https://runner.test/",
    locationSchedules: [currentRule],
  };
}

function request(currentRule: LocationScheduleRule, tool = "calendar_list_calendars") {
  return {
    requestId: "request-1",
    requestHash: "hash-1",
    ruleId: currentRule.id,
    ruleRevision: locationScheduleRevision(currentRule),
    tool,
    arguments: { eventId: "event-1" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as typeof fetch;
  mockSecureStoreGet.mockImplementation((key: string) => {
    if (key === "bitty.pushDeviceId.v2") return "device-1";
    if (key === "bitty.runnerToken.v2") return "token";
    return "";
  });
  mockReadPersistedSettings.mockResolvedValue(settings());
  mockGetCalendarPermission.mockResolvedValue({ ok: true, data: null });
  mockListCalendars.mockResolvedValue({ ok: true, data: [{ id: "calendar-1" }] });
  mockSearchEvents.mockResolvedValue({ ok: true, data: [] });
  mockGetEvent.mockResolvedValue({ ok: true, data: { id: "event-1" } });
  mockRecoverLocationScheduleState.mockResolvedValue(undefined);
});

test("registers one task callback and splits calendar and location markers", async () => {
  expect(backgroundTaskCallback).toBeInstanceOf(Function);
  await backgroundTaskCallback({ data: { marker: "location_state_refresh" } });
  expect(mockRecoverLocationScheduleState).toHaveBeenCalledWith("silent_push");

  await dispatchBackgroundNotification({ marker: "calendar_request_available" });
  expect(mockRecoverLocationScheduleState).toHaveBeenCalledTimes(1);
});

test("gets a request, runs a read-only tool, then posts its result", async () => {
  const currentRule = rule();
  mockReadPersistedSettings.mockResolvedValue(settings(currentRule));
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [request(currentRule)] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

  await processCalendarRequests();

  expect(mockGetCalendarPermission).toHaveBeenCalledWith();
  expect(mockListCalendars).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenNthCalledWith(1, "https://runner.test/calendar/requests?deviceId=device-1", expect.any(Object));
  expect(mockFetch).toHaveBeenNthCalledWith(2, "https://runner.test/calendar/requests/request-1/result", expect.objectContaining({ method: "POST" }));
});

test("does not execute expired, unauthorized, or write requests", async () => {
  const currentRule = rule();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      requests: [
        { ...request(currentRule, "calendar_create_event"), requestId: "write" },
        { ...request(currentRule), requestId: "expired", expiresAt: "2000-01-01T00:00:00.000Z" },
      ],
    }),
  });

  await processCalendarRequests();

  expect(mockListCalendars).not.toHaveBeenCalled();
  expect(mockSearchEvents).not.toHaveBeenCalled();
  expect(mockGetEvent).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test("requires a configured runner before any network work", async () => {
  mockReadPersistedSettings.mockResolvedValue({});

  await processCalendarRequests();

  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockGetCalendarPermission).not.toHaveBeenCalled();
});

test.each([
  ["disabled rule", rule({ enabled: false })],
  ["write access", rule({ calendarAccess: "none", calendarDeviceId: null })],
  ["other device", rule({ calendarDeviceId: "device-2" })],
  ["changed revision", rule({ prompt: "changed" })],
])("requires the live %s gate before executing a tool", async (_name, liveRule) => {
  const currentRule = rule();
  mockReadPersistedSettings
    .mockResolvedValueOnce(settings(currentRule))
    .mockResolvedValueOnce(settings(liveRule));
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [request(currentRule)] }) });

  await processCalendarRequests();

  expect(mockGetCalendarPermission).not.toHaveBeenCalled();
  expect(mockListCalendars).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test("rechecks the live rule before posting", async () => {
  const currentRule = rule();
  mockReadPersistedSettings
    .mockResolvedValueOnce(settings(currentRule))
    .mockResolvedValueOnce(settings(currentRule))
    .mockResolvedValueOnce(settings(rule({ enabled: false })));
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [request(currentRule)] }) });

  await processCalendarRequests();

  expect(mockListCalendars).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test("bounds a wake to three requests and configures both request and wake deadlines", async () => {
  const currentRule = rule();
  const requests = ["one", "two", "three", "four"].map((requestId) => ({ ...request(currentRule), requestId }));
  mockFetch.mockImplementation((url: string) => (
    String(url).includes("/result")
      ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      : Promise.resolve({ ok: true, json: async () => ({ requests }) })
  ));
  const timers = jest.spyOn(global, "setTimeout");

  await processCalendarRequests();

  expect(mockListCalendars).toHaveBeenCalledTimes(3);
  expect(mockFetch).toHaveBeenCalledTimes(4);
  expect(timers).toHaveBeenCalledWith(expect.any(Function), 18_000);
  expect(timers).toHaveBeenCalledWith(expect.any(Function), 5_000);
});
