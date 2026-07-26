const mockGetCalendarPermissionsAsync = jest.fn();
const mockRequestCalendarPermissionsAsync = jest.fn();

jest.mock("expo-calendar", () => ({
  getCalendarPermissionsAsync: () => mockGetCalendarPermissionsAsync(),
  requestCalendarPermissionsAsync: () => mockRequestCalendarPermissionsAsync(),
}));

import { getCalendarPermission, requestCalendarPermission } from "./calendarService";

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
