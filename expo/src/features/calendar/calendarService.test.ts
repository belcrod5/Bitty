const mockGetCalendarPermissionsAsync = jest.fn();
const mockRequestCalendarPermissionsAsync = jest.fn();

jest.mock("expo-calendar", () => ({
  getCalendarPermissionsAsync: () => mockGetCalendarPermissionsAsync(),
  requestCalendarPermissionsAsync: () => mockRequestCalendarPermissionsAsync(),
}));

import { getCalendarPermission, requestCalendarPermission } from "./calendarService";

const appConfig = require("../../../app.json").expo;

beforeEach(() => {
  jest.clearAllMocks();
});

test("calendar tool checks never prompt for undetermined permission", async () => {
  mockGetCalendarPermissionsAsync.mockResolvedValue({ granted: false, status: "undetermined" });

  await expect(getCalendarPermission()).resolves.toMatchObject({
    ok: false,
    error: { code: "calendar_permission_undetermined" },
  });
  expect(mockRequestCalendarPermissionsAsync).not.toHaveBeenCalled();
});

test("only the explicit settings action requests calendar permission", async () => {
  mockGetCalendarPermissionsAsync.mockResolvedValue({ granted: false, status: "undetermined" });
  mockRequestCalendarPermissionsAsync.mockResolvedValue({ granted: true });

  await expect(requestCalendarPermission()).resolves.toEqual({ ok: true, data: null });
  expect(mockRequestCalendarPermissionsAsync).toHaveBeenCalledTimes(1);
});

test("calendar config supplies every iOS calendar and reminder privacy description", () => {
  const calendarPlugin = appConfig.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-calendar",
  );
  expect(calendarPlugin).toBeDefined();

  const permissions = calendarPlugin[1];
  expect(permissions.calendarPermission).toBe(appConfig.ios.infoPlist.NSCalendarsUsageDescription);
  expect(permissions.calendarPermission).toBe(appConfig.ios.infoPlist.NSCalendarsFullAccessUsageDescription);
  expect(permissions.remindersPermission).toBe(appConfig.ios.infoPlist.NSRemindersUsageDescription);
  expect(permissions.remindersPermission).toBe(appConfig.ios.infoPlist.NSRemindersFullAccessUsageDescription);
});
