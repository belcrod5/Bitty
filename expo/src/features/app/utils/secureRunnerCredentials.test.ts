const mockGetItemAsync = jest.fn();
const mockSetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();

jest.mock("expo-secure-store", () => ({
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}));

import {
  loadSecureRunnerCredentials,
  saveSecureRunnerCredentials,
} from "./secureRunnerCredentials";

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

test("deletes credentials only when an explicit empty value is saved", async () => {
  await saveSecureRunnerCredentials({
    runnerToken: "",
    cloudflareAccessClientId: "client-id",
    cloudflareAccessClientSecret: "client-secret",
  });

  expect(mockDeleteItemAsync).toHaveBeenCalledWith("bitty.runnerToken");
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.cloudflareAccessClientId", "client-id");
  expect(mockSetItemAsync).toHaveBeenCalledWith("bitty.cloudflareAccessClientSecret", "client-secret");
});
