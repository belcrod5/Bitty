const mockGetItemAsync = jest.fn();
const mockSetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: 0,
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}));

import {
  loadSecureRunnerCredentials,
  saveSecureRunnerCredentials,
} from "./secureRunnerCredentials";

const AFTER_FIRST_UNLOCK_OPTIONS = expect.objectContaining({ keychainAccessible: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetItemAsync.mockResolvedValue(null);
  mockSetItemAsync.mockResolvedValue(undefined);
  mockDeleteItemAsync.mockResolvedValue(undefined);
});

test("distinguishes an unavailable secure store from missing credentials", async () => {
  mockGetItemAsync.mockRejectedValue(new Error("secure store temporarily unavailable"));

  await expect(loadSecureRunnerCredentials()).rejects.toThrow("secure store temporarily unavailable");
});

test("represents missing credentials as empty values", async () => {
  await expect(loadSecureRunnerCredentials()).resolves.toEqual({
    runnerToken: "",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });
});

test("prefers the v2 key and falls back to the legacy key per field", async () => {
  mockGetItemAsync.mockImplementation(async (key: string) => {
    if (key === "bitty.runnerToken.v2") return "v2-token";
    if (key === "bitty.cloudflareAccessClientId") return "legacy-client-id";
    return null;
  });

  await expect(loadSecureRunnerCredentials()).resolves.toEqual({
    runnerToken: "v2-token",
    cloudflareAccessClientId: "legacy-client-id",
    cloudflareAccessClientSecret: "",
  });
});

test("reads with the AFTER_FIRST_UNLOCK accessibility so locked-device launches can load credentials", async () => {
  await loadSecureRunnerCredentials();

  expect(mockGetItemAsync.mock.calls.length).toBeGreaterThan(0);
  for (const call of mockGetItemAsync.mock.calls) {
    expect(call[1]).toEqual(AFTER_FIRST_UNLOCK_OPTIONS);
  }
});

test("saving a value sets the v2 key first and never deletes it", async () => {
  await saveSecureRunnerCredentials({ runnerToken: "token-1" });

  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.runnerToken.v2", "token-1", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken", AFTER_FIRST_UNLOCK_OPTIONS);
  // The credential must exist under some key at every point in time: the new copy is
  // written before the legacy copy is removed, and the v2 key itself is never deleted.
  const setOrder = mockSetItemAsync.mock.invocationCallOrder[0];
  const deleteOrder = mockDeleteItemAsync.mock.invocationCallOrder[0];
  expect(setOrder).toBeLessThan(deleteOrder);
  expect(mockDeleteItemAsync).not.toHaveBeenCalledWith("bitty.runnerToken.v2", expect.anything());
});

test("deletes both copies only when an explicit empty value is saved", async () => {
  await saveSecureRunnerCredentials({
    runnerToken: "",
    cloudflareAccessClientId: "client-id",
  });

  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken.v2", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockSetItemAsync).not.toHaveBeenCalledWith("bitty.runnerToken.v2", expect.anything(), expect.anything());
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.cloudflareAccessClientId.v2", "client-id", AFTER_FIRST_UNLOCK_OPTIONS);
});

test("never touches credentials that are omitted from a partial save", async () => {
  await saveSecureRunnerCredentials({
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });

  const touchedKeys = [
    ...mockSetItemAsync.mock.calls,
    ...mockDeleteItemAsync.mock.calls,
  ].map((call) => call[0]);
  expect(touchedKeys).not.toContain("bitty.runnerToken");
  expect(touchedKeys).not.toContain("bitty.runnerToken.v2");
});
