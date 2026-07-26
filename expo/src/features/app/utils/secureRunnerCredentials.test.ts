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
});

test("distinguishes an unavailable secure store from missing credentials", async () => {
  mockGetItemAsync.mockRejectedValue(new Error("secure store temporarily unavailable"));

  await expect(loadSecureRunnerCredentials()).rejects.toThrow("secure store temporarily unavailable");
});

test("represents missing credentials as empty values", async () => {
  mockGetItemAsync.mockResolvedValue(null);

  await expect(loadSecureRunnerCredentials()).resolves.toEqual({
    runnerToken: "",
    cloudflareAccessClientId: "",
    cloudflareAccessClientSecret: "",
  });
});

test("reads with the AFTER_FIRST_UNLOCK accessibility so locked-device launches can load credentials", async () => {
  mockGetItemAsync.mockResolvedValue(null);

  await loadSecureRunnerCredentials();

  expect(mockGetItemAsync).toHaveBeenCalledTimes(3);
  for (const call of mockGetItemAsync.mock.calls) {
    expect(call[1]).toEqual(AFTER_FIRST_UNLOCK_OPTIONS);
  }
});

test("deletes a credential only when an explicit empty value is saved", async () => {
  await saveSecureRunnerCredentials({
    runnerToken: "",
    cloudflareAccessClientId: "client-id",
    cloudflareAccessClientSecret: "client-secret",
  });

  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockSetItemAsync).not.toHaveBeenCalledWith("bitty.runnerToken", expect.anything(), expect.anything());
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.cloudflareAccessClientId", "client-id", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.cloudflareAccessClientSecret", "client-secret", AFTER_FIRST_UNLOCK_OPTIONS);
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
});

test("rewrites saved credentials via delete + set so the accessibility attribute migrates", async () => {
  await saveSecureRunnerCredentials({ runnerToken: "token-1" });

  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken", AFTER_FIRST_UNLOCK_OPTIONS);
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.runnerToken", "token-1", AFTER_FIRST_UNLOCK_OPTIONS);
});
