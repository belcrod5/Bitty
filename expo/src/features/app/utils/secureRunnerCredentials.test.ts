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
import { clearSecureRunnerSession, loadSecureRunnerCredentials, runnerCredentialScope, saveSecureRunnerCredentials } from "./secureRunnerCredentials";
const SESSION_A = "bitty_session_v1." + "a".repeat(43);
const SESSION_B = "bitty_session_v1." + "b".repeat(43);
const KEY = "bitty.runnerCredentials.v3";
const SCOPE = { cloudflareOrigin: "https://runner.test", localOrigin: "https://mac.local:8789" };
const OTHER_SCOPE = { cloudflareOrigin: "https://other.test", localOrigin: "https://other.local:8789" };
const OPTIONS = expect.objectContaining({ keychainAccessible: 0 });
const EMPTY = { runnerToken: "", cloudflareAccessClientId: "", cloudflareAccessClientSecret: "" };
const record = (token = SESSION_A) => ({ version: 3, scope: SCOPE, ...EMPTY, runnerToken: token, cloudflareAccessClientId: "access-id", cloudflareAccessClientSecret: "access-secret" });
beforeEach(() => {
  jest.resetAllMocks(); storedValues = new Map();
  mockGetItemAsync.mockImplementation(async (key: string) => storedValues.get(key) ?? null);
  mockSetItemAsync.mockImplementation(async (key: string, value: string) => { storedValues.set(key, value); });
  mockDeleteItemAsync.mockImplementation(async (key: string) => { storedValues.delete(key); });
});
test("distinguishes unavailable Keychain from absent credentials", async () => {
  mockGetItemAsync.mockRejectedValue(new Error("unavailable"));
  await expect(loadSecureRunnerCredentials(SCOPE)).rejects.toThrow("unavailable");
});
test("legacy per-field credentials cannot silently become paired sessions or Access credentials", async () => {
  storedValues.set("bitty.runnerToken.v2", "legacy-token");
  storedValues.set("bitty.cloudflareAccessClientSecret.v2", "old-secret");
  await expect(loadSecureRunnerCredentials(SCOPE)).resolves.toEqual(EMPTY);
  expect(mockGetItemAsync).toHaveBeenCalledTimes(1);
});
test("loads one atomic scoped record with background accessibility", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  expect((await loadSecureRunnerCredentials(SCOPE)).runnerToken).toBe(SESSION_A);
  expect(mockGetItemAsync).toHaveBeenCalledWith(KEY, OPTIONS);
});
test("settings read failure or an interrupted QR settings save cannot attach secrets to a different Runner", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  await expect(loadSecureRunnerCredentials(null)).resolves.toEqual(EMPTY);
  await expect(loadSecureRunnerCredentials(OTHER_SCOPE)).resolves.toEqual(EMPTY);
});
test("LAN and Tunnel selection have the same scope, but unpaired selections do not", () => {
  expect(runnerCredentialScope({ runnerUrl: SCOPE.cloudflareOrigin, cloudflareRunnerUrl: SCOPE.cloudflareOrigin, localRunnerUrl: SCOPE.localOrigin })).toEqual(SCOPE);
  expect(runnerCredentialScope({ runnerUrl: SCOPE.localOrigin, cloudflareRunnerUrl: SCOPE.cloudflareOrigin, localRunnerUrl: SCOPE.localOrigin })).toEqual(SCOPE);
  expect(runnerCredentialScope({ runnerUrl: "https://attacker.test", cloudflareRunnerUrl: SCOPE.cloudflareOrigin, localRunnerUrl: SCOPE.localOrigin })).toBeNull();
});
test("rejects shared tokens and unbound secrets before writing", async () => {
  await expect(saveSecureRunnerCredentials({ runnerToken: "legacy" }, SCOPE)).rejects.toThrow("runner_session_required");
  await expect(saveSecureRunnerCredentials({ runnerToken: SESSION_A })).rejects.toThrow("runner_configuration_required");
  expect(mockSetItemAsync).not.toHaveBeenCalled();
});
test("persists all secrets with their allowed origins in a single item", async () => {
  await saveSecureRunnerCredentials({ runnerToken: SESSION_A, cloudflareAccessClientId: "id", cloudflareAccessClientSecret: "secret" }, SCOPE);
  expect(mockSetItemAsync).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(storedValues.get(KEY)!);
  expect(saved).toMatchObject({ version: 3, scope: SCOPE, runnerToken: SESSION_A, cloudflareAccessClientId: "id", cloudflareAccessClientSecret: "secret" });
});
test("readback failure restores the previous whole record", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  let corrupt = false;
  mockSetItemAsync.mockImplementation(async (key: string, value: string) => { storedValues.set(key, value); if (value.includes(SESSION_B)) corrupt = true; });
  mockGetItemAsync.mockImplementation(async (key: string) => {
    if (key === KEY && corrupt) { corrupt = false; return "corrupt"; }
    return storedValues.get(key) ?? null;
  });
  await expect(saveSecureRunnerCredentials({ runnerToken: SESSION_B }, SCOPE)).rejects.toThrow("secure_credentials_readback_mismatch");
  expect(JSON.parse(storedValues.get(KEY)!)).toEqual(record());
});
test("an old 401 cannot erase a newer serialized login", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  const login = saveSecureRunnerCredentials({ runnerToken: SESSION_B }, SCOPE);
  const staleClear = clearSecureRunnerSession(SESSION_A);
  await login; await expect(staleClear).resolves.toBe(false);
  expect((await loadSecureRunnerCredentials(SCOPE)).runnerToken).toBe(SESSION_B);
});
test("an old login cannot overwrite a newly paired connection", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  await saveSecureRunnerCredentials({ runnerToken: "", cloudflareAccessClientId: "new-id", cloudflareAccessClientSecret: "new-secret" }, OTHER_SCOPE);
  await expect(saveSecureRunnerCredentials({ runnerToken: SESSION_B }, SCOPE)).rejects.toThrow("runner_configuration_changed");
  expect((await loadSecureRunnerCredentials(OTHER_SCOPE)).cloudflareAccessClientId).toBe("new-id");
  await expect(loadSecureRunnerCredentials(SCOPE)).resolves.toEqual(EMPTY);
});
test("expiry clears only the matching session and preserves its transport settings", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  await expect(clearSecureRunnerSession(SESSION_A)).resolves.toBe(true);
  expect(await loadSecureRunnerCredentials(SCOPE)).toEqual({ ...EMPTY, cloudflareAccessClientId: "access-id", cloudflareAccessClientSecret: "access-secret" });
});

test("an in-flight credential recovery cannot restore a session after logout or pairing", async () => {
  storedValues.set(KEY, JSON.stringify(record()));
  let resolve!: (value: string) => void;
  mockGetItemAsync.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  const recovering = loadSecureRunnerCredentials(SCOPE);
  const logout = saveSecureRunnerCredentials({ runnerToken: "" }, SCOPE);
  resolve(JSON.stringify(record()));
  await logout;
  await expect(recovering).resolves.toEqual(EMPTY);
});

test("corrupt credential data fails closed without exposing JSON fragments in the error", async () => {
  storedValues.set(KEY, '{"runnerToken":"sensitive-fragment"');
  await expect(loadSecureRunnerCredentials(SCOPE)).rejects.toThrow(/^invalid_runner_credentials$/);
});
