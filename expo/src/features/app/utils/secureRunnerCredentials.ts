import * as SecureStore from "expo-secure-store";

export type SecureRunnerCredentials = {
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
};

// v2 keys are written with AFTER_FIRST_UNLOCK so locked-device background launches
// (location/schedule wakeups, push approval actions) can read credentials. Legacy keys
// were created with the WHEN_UNLOCKED default and cannot be re-attributed in place
// (SecItemUpdate keeps the original kSecAttrAccessible), which is why migration moves
// each value to a new key instead of rewriting the old one. Saves always set the v2
// key before touching the legacy key, so an interruption can leave two copies of a
// credential, never zero.
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const FIELDS = [
  "runnerToken",
  "cloudflareAccessClientId",
  "cloudflareAccessClientSecret",
] as const;
type SecureCredentialField = (typeof FIELDS)[number];

const KEY_BY_FIELD: Record<SecureCredentialField, string> = {
  runnerToken: "bitty.runnerToken.v2",
  cloudflareAccessClientId: "bitty.cloudflareAccessClientId.v2",
  cloudflareAccessClientSecret: "bitty.cloudflareAccessClientSecret.v2",
};

const LEGACY_KEY_BY_FIELD: Record<SecureCredentialField, string> = {
  runnerToken: "bitty.runnerToken",
  cloudflareAccessClientId: "bitty.cloudflareAccessClientId",
  cloudflareAccessClientSecret: "bitty.cloudflareAccessClientSecret",
};

async function readKey(key: string) {
  return String(await SecureStore.getItemAsync(key, KEYCHAIN_OPTIONS) || "").trim();
}

async function readField(field: SecureCredentialField) {
  const value = await readKey(KEY_BY_FIELD[field]);
  if (value) return value;
  return readKey(LEGACY_KEY_BY_FIELD[field]);
}

async function writeField(field: SecureCredentialField, valueRaw: string) {
  const value = String(valueRaw || "").trim();
  if (value) {
    // Set before delete: the value must exist under some key at every point in time.
    await SecureStore.setItemAsync(KEY_BY_FIELD[field], value, KEYCHAIN_OPTIONS);
    await SecureStore.deleteItemAsync(LEGACY_KEY_BY_FIELD[field], KEYCHAIN_OPTIONS);
  } else {
    await SecureStore.deleteItemAsync(KEY_BY_FIELD[field], KEYCHAIN_OPTIONS);
    await SecureStore.deleteItemAsync(LEGACY_KEY_BY_FIELD[field], KEYCHAIN_OPTIONS);
  }
}

export async function loadSecureRunnerCredentials(): Promise<SecureRunnerCredentials> {
  const [runnerToken, cloudflareAccessClientId, cloudflareAccessClientSecret] = await Promise.all([
    readField("runnerToken"),
    readField("cloudflareAccessClientId"),
    readField("cloudflareAccessClientSecret"),
  ]);
  return {
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
  };
}

// Writes only the fields present in the partial: an explicitly provided empty string
// deletes that credential, an omitted field is never touched. Callers therefore cannot
// delete a credential they did not intend to change.
export async function saveSecureRunnerCredentials(credentials: Partial<SecureRunnerCredentials>) {
  await Promise.all(
    FIELDS
      .filter((field) => typeof credentials[field] === "string")
      .map((field) => writeField(field, credentials[field] as string))
  );
}
