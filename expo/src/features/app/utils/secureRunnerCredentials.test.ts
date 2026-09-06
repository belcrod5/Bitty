const mockGetItemAsync = jest.fn();
const mockSetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();
let storedValues: Map<string, string>;

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
  storedValues = new Map();
  mockGetItemAsync.mockImplementation(async (key: string) => storedValues.get(key) ?? null);
  mockSetItemAsync.mockImplementation(async (key: string, value: string) => {
    storedValues.set(key, value);
  });
  mockDeleteItemAsync.mockImplementation(async (key: string) => {
    storedValues.delete(key);
  });
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

test("saving succeeds only after the stored value is read back", async () => {
  await expect(saveSecureRunnerCredentials({ runnerToken: " token-1 " })).resolves.toBeUndefined();

  expect(mockGetItemAsync).toHaveBeenLastCalledWith("bitty.runnerToken.v2", expect.objectContaining({
    authenticationPrompt: expect.stringContaining("キーチェーン"),
  }));
  expect(storedValues.get("bitty.runnerToken.v2")).toBe("token-1");
});

test("surfaces a keychain write rejection and keeps the previous value", async () => {
  storedValues.set("bitty.runnerToken.v2", "old-token");
  mockSetItemAsync.mockRejectedValueOnce(new Error("User denied keychain access"));

  await expect(saveSecureRunnerCredentials({ runnerToken: "new-token" }))
    .rejects.toThrow("User denied keychain access");
  expect(storedValues.get("bitty.runnerToken.v2")).toBe("old-token");
});

test("rejects a readback mismatch and restores the previous value", async () => {
  storedValues.set("bitty.runnerToken.v2", "old-token");
  let corruptNextRead = false;
  mockSetItemAsync.mockImplementation(async (key: string, value: string) => {
    storedValues.set(key, value);
    if (value === "new-token") corruptNextRead = true;
  });
  mockGetItemAsync.mockImplementation(async (key: string) => {
    if (key === "bitty.runnerToken.v2" && corruptNextRead) {
      corruptNextRead = false;
      return "different-token";
    }
    return storedValues.get(key) ?? null;
  });

  await expect(saveSecureRunnerCredentials({ runnerToken: "new-token" }))
    .rejects.toThrow("secure_credentials_readback_mismatch: runnerToken");
  expect(storedValues.get("bitty.runnerToken.v2")).toBe("old-token");
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
