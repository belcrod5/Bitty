import * as SecureStore from "expo-secure-store";

const RUNNER_TOKEN_KEY = "bitty.runnerToken";
const CF_ACCESS_CLIENT_ID_KEY = "bitty.cloudflareAccessClientId";
const CF_ACCESS_CLIENT_SECRET_KEY = "bitty.cloudflareAccessClientSecret";

// Credentials must stay readable during locked-device background launches (location and
// schedule wakeups, push approval actions). The expo-secure-store default is
// WHEN_UNLOCKED, which makes every read fail while the device is locked.
export const SECURE_CREDENTIAL_KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export type SecureRunnerCredentials = {
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
};

const KEY_BY_FIELD: Record<keyof SecureRunnerCredentials, string> = {
  runnerToken: RUNNER_TOKEN_KEY,
  cloudflareAccessClientId: CF_ACCESS_CLIENT_ID_KEY,
  cloudflareAccessClientSecret: CF_ACCESS_CLIENT_SECRET_KEY,
};

const CREDENTIAL_FIELDS = Object.keys(KEY_BY_FIELD) as (keyof SecureRunnerCredentials)[];

async function read(key: string) {
  return String(await SecureStore.getItemAsync(key, SECURE_CREDENTIAL_KEYCHAIN_OPTIONS) || "").trim();
}

async function write(key: string, valueRaw: string) {
  const value = String(valueRaw || "").trim();
  // Items written before the AFTER_FIRST_UNLOCK rollout keep their original
  // accessibility on update (SecItemUpdate does not replace kSecAttrAccessible),
  // so delete first to guarantee the new attribute applies.
  await SecureStore.deleteItemAsync(key, SECURE_CREDENTIAL_KEYCHAIN_OPTIONS);
  if (value) {
    await SecureStore.setItemAsync(key, value, SECURE_CREDENTIAL_KEYCHAIN_OPTIONS);
  }
}

export async function loadSecureRunnerCredentials(): Promise<SecureRunnerCredentials> {
  const [runnerToken, cloudflareAccessClientId, cloudflareAccessClientSecret] = await Promise.all([
    read(RUNNER_TOKEN_KEY),
    read(CF_ACCESS_CLIENT_ID_KEY),
    read(CF_ACCESS_CLIENT_SECRET_KEY),
  ]);
  return {
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
  };
}

// Writes only the fields present in the partial: an explicitly provided empty string
// deletes that key, an omitted field is never touched. Callers therefore cannot
// delete a credential they did not intend to change.
export async function saveSecureRunnerCredentials(credentials: Partial<SecureRunnerCredentials>) {
  await Promise.all(
    CREDENTIAL_FIELDS
      .filter((field) => typeof credentials[field] === "string")
      .map((field) => write(KEY_BY_FIELD[field], credentials[field] as string))
  );
}
