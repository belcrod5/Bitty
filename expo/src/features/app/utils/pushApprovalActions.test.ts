import {
  handlePushApprovalAction,
  readFaceIdRequiredFromDisk,
  readRunnerUrlFromDisk,
  respondToPushApproval,
} from "./pushApprovalActions";
import { loadSecureRunnerCredentials } from "./secureRunnerCredentials";

let mockSettingsFileContent: string | null = null;

jest.mock("expo-file-system/legacy", () => ({
  get documentDirectory() {
    return "file:///mock-doc-dir/";
  },
  getInfoAsync: jest.fn(async () => ({ exists: mockSettingsFileContent !== null })),
  readAsStringAsync: jest.fn(async () => mockSettingsFileContent || "{}"),
}));

const mockAuthenticateAsync = jest.fn();
const mockHasHardwareAsync = jest.fn();
const mockIsEnrolledAsync = jest.fn();

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: (...args: unknown[]) => mockHasHardwareAsync(...args),
  isEnrolledAsync: (...args: unknown[]) => mockIsEnrolledAsync(...args),
  authenticateAsync: (...args: unknown[]) => mockAuthenticateAsync(...args),
}));

const mockScheduleNotificationAsync = jest.fn();

jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
}));

jest.mock("./secureRunnerCredentials", () => ({
  loadSecureRunnerCredentials: jest.fn(),
}));

const mockLoadSecureRunnerCredentials = loadSecureRunnerCredentials as jest.Mock;

describe("readRunnerUrlFromDisk / readFaceIdRequiredFromDisk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsFileContent = null;
  });

  it("returns empty/false when the settings file does not exist", async () => {
    expect(await readRunnerUrlFromDisk()).toBe("");
    expect(await readFaceIdRequiredFromDisk()).toBe(false);
  });

  it("reads runnerUrl and faceIdRequiredForApproval from the persisted settings file", async () => {
    mockSettingsFileContent = JSON.stringify({
      runnerUrl: "https://runner.example.com",
      faceIdRequiredForApproval: true,
    });
    expect(await readRunnerUrlFromDisk()).toBe("https://runner.example.com");
    expect(await readFaceIdRequiredFromDisk()).toBe(true);
  });

  it("treats a missing or non-boolean faceIdRequiredForApproval as false", async () => {
    mockSettingsFileContent = JSON.stringify({ runnerUrl: "https://runner.example.com" });
    expect(await readFaceIdRequiredFromDisk()).toBe(false);
  });
});

describe("respondToPushApproval", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns false without calling fetch when required fields are missing", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await respondToPushApproval({
      runnerUrl: "",
      runnerToken: "token",
      approvalId: "relay:rpc",
      approved: true,
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /push/approvals/:approvalId/respond with a bearer token and URL-encoded id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, enabled: true, approved: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await respondToPushApproval({
      runnerUrl: "https://runner.example.com/",
      runnerToken: "secret-token",
      approvalId: "relay-1:rpc/2",
      approved: true,
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.example.com/push/approvals/relay-1%3Arpc%2F2/respond",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ approved: true }),
      })
    );
    // No Cloudflare Access credentials were provided, so no CF headers may be attached.
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBeUndefined();
    expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
  });

  it("attaches Cloudflare Access headers when credentials are provided", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await respondToPushApproval({
      runnerUrl: "https://runner.example.com",
      runnerToken: "secret-token",
      approvalId: "relay:rpc",
      approved: false,
      cloudflareAccessClientId: "cf-id",
      cloudflareAccessClientSecret: "cf-secret",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/push/approvals/"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "CF-Access-Client-Id": "cf-id",
          "CF-Access-Client-Secret": "cf-secret",
        }),
      })
    );
  });

  it("throws with the server-provided message on non-OK responses (e.g. 409 already answered)", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "approval_not_pending" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      respondToPushApproval({
        runnerUrl: "https://runner.example.com",
        runnerToken: "token",
        approvalId: "relay:rpc",
        approved: true,
      })
    ).rejects.toThrow("approval_not_pending");
  });
});

describe("handlePushApprovalAction", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsFileContent = JSON.stringify({ runnerUrl: "https://runner.example.com" });
    mockLoadSecureRunnerCredentials.mockResolvedValue({
      runnerToken: "secret-token",
      cloudflareAccessClientId: "",
      cloudflareAccessClientSecret: "",
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("ignores actions outside the APPROVAL_REQUEST category", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "TURN_COMPLETED",
      actionIdentifier: "approve",
      approvalId: "relay:rpc",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deny always responds immediately without any Face ID check, regardless of the setting", async () => {
    mockSettingsFileContent = JSON.stringify({
      runnerUrl: "https://runner.example.com",
      faceIdRequiredForApproval: true,
    });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "deny",
      approvalId: "relay:rpc",
    });

    expect(mockHasHardwareAsync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/push/approvals/relay%3Arpc/respond"),
      expect.objectContaining({ body: JSON.stringify({ approved: false }) })
    );
  });

  it("attaches Cloudflare Access headers from secure-store credentials on background responds", async () => {
    mockLoadSecureRunnerCredentials.mockResolvedValue({
      runnerToken: "secret-token",
      cloudflareAccessClientId: "cf-id-from-store",
      cloudflareAccessClientSecret: "cf-secret-from-store",
    });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "deny",
      approvalId: "relay:rpc",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/push/approvals/"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "CF-Access-Client-Id": "cf-id-from-store",
          "CF-Access-Client-Secret": "cf-secret-from-store",
        }),
      })
    );
  });

  it("approve responds immediately without Face ID when the setting is OFF", async () => {
    mockSettingsFileContent = JSON.stringify({
      runnerUrl: "https://runner.example.com",
      faceIdRequiredForApproval: false,
    });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "approve",
      approvalId: "relay:rpc",
    });

    expect(mockHasHardwareAsync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/push/approvals/relay%3Arpc/respond"),
      expect.objectContaining({ body: JSON.stringify({ approved: true }) })
    );
  });

  it("approve requires a successful Face ID authentication before responding when the setting is ON", async () => {
    mockSettingsFileContent = JSON.stringify({
      runnerUrl: "https://runner.example.com",
      faceIdRequiredForApproval: true,
    });
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockAuthenticateAsync.mockResolvedValue({ success: true });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "approve",
      approvalId: "relay:rpc",
    });

    expect(mockAuthenticateAsync).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/push/approvals/relay%3Arpc/respond"),
      expect.objectContaining({ body: JSON.stringify({ approved: true }) })
    );
  });

  it("approve does not respond when Face ID authentication fails/cancels", async () => {
    mockSettingsFileContent = JSON.stringify({
      runnerUrl: "https://runner.example.com",
      faceIdRequiredForApproval: true,
    });
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    mockAuthenticateAsync.mockResolvedValue({ success: false });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "approve",
      approvalId: "relay:rpc",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires a lightweight local fallback notification when the respond call fails (e.g. network error)", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await handlePushApprovalAction({
      categoryIdentifier: "APPROVAL_REQUEST",
      actionIdentifier: "deny",
      approvalId: "relay:rpc",
    });

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: "承認の送信に失敗しました" }),
        trigger: null,
      })
    );
  });

  it("fires the fallback notification on a 409 (already answered / expired) instead of throwing", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "approval_not_pending" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      handlePushApprovalAction({
        categoryIdentifier: "APPROVAL_REQUEST",
        actionIdentifier: "deny",
        approvalId: "relay:rpc",
      })
    ).resolves.toBeUndefined();

    expect(mockScheduleNotificationAsync).toHaveBeenCalled();
  });
});
