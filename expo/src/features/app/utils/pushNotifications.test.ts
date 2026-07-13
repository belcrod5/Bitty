import {
  getOrCreatePushDeviceId,
  registerPushDevice,
  resolveForegroundNotificationBehavior,
} from "./pushNotifications";

const mockSecureStoreState = new Map<string, string>();

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStoreState.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreState.set(key, value);
  }),
}));

describe("resolveForegroundNotificationBehavior", () => {
  it("suppresses all foreground presentation so the in-app card is the single source of truth", () => {
    expect(resolveForegroundNotificationBehavior()).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });
});

describe("getOrCreatePushDeviceId", () => {
  beforeEach(() => {
    mockSecureStoreState.clear();
    jest.clearAllMocks();
  });

  it("creates and persists a new device id when none is stored", async () => {
    const deviceId = await getOrCreatePushDeviceId();
    expect(deviceId).toMatch(/^push_/);
    expect(mockSecureStoreState.get("bitty.pushDeviceId")).toBe(deviceId);
  });

  it("returns the same id on subsequent calls instead of generating a new one", async () => {
    const first = await getOrCreatePushDeviceId();
    const second = await getOrCreatePushDeviceId();
    expect(second).toBe(first);
  });
});

describe("registerPushDevice", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns false without calling fetch when runnerUrl/runnerToken/device fields are missing", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await registerPushDevice({
      runnerUrl: "",
      runnerToken: "token",
      deviceId: "device-1",
      apnsToken: "apns-1",
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /push/devices with a bearer token and the device payload", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, enabled: true, device: { deviceId: "device-1" } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await registerPushDevice({
      runnerUrl: "https://runner.example.com/",
      runnerToken: "secret-token",
      deviceId: "device-1",
      apnsToken: "apns-token-1",
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.example.com/push/devices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ deviceId: "device-1", apnsToken: "apns-token-1" }),
      })
    );
  });

  it("throws with the server-provided message when the request fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      registerPushDevice({
        runnerUrl: "https://runner.example.com",
        runnerToken: "bad-token",
        deviceId: "device-1",
        apnsToken: "apns-token-1",
      })
    ).rejects.toThrow("unauthorized");
  });
});
