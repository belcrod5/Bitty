import { requestICloudCalendar } from "./icloudCalendarClient";

beforeEach(() => jest.restoreAllMocks());

test("cloud credentials require HTTPS and forbid redirecting credential request bodies", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ configured: false, enabled: false, account: "", testedAt: null }) } as Response);
  await expect(requestICloudCalendar("http://mac.local:8788", "token", "test", { method: "POST", body: "secret" })).rejects.toThrow("HTTPS");
  expect(fetchMock).not.toHaveBeenCalled();
  await requestICloudCalendar("https://runner.example.com", "token", "status");
  expect(fetchMock).toHaveBeenCalledWith("https://runner.example.com/calendar/icloud/status", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
});

test("invalid status or connection-test responses cannot be shown as successful", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ configured: true }) } as Response);
  await expect(requestICloudCalendar("https://runner.example.com", "token", "status")).rejects.toThrow("応答");
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ verificationToken: "fake-success", expiresAt: "later", calendarCount: 1, eventCount: 1 }) } as Response);
  await expect(requestICloudCalendar("https://runner.example.com", "token", "test")).rejects.toThrow("応答");
});
