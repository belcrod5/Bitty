import * as SecureStore from "expo-secure-store";

const RUNNER_TOKEN_KEY = "bitty.runnerToken";
const CF_ACCESS_CLIENT_ID_KEY = "bitty.cloudflareAccessClientId";
const CF_ACCESS_CLIENT_SECRET_KEY = "bitty.cloudflareAccessClientSecret";

export type SecureRunnerCredentials = {
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
};

async function read(key: string) {
  try {
    return String(await SecureStore.getItemAsync(key) || "").trim();
  } catch {
    return "";
  }
}

async function write(key: string, valueRaw: string) {
  const value = String(valueRaw || "").trim();
  try {
    if (value) {
      await SecureStore.setItemAsync(key, value);
    } else {
      await SecureStore.deleteItemAsync(key);
    }
  } catch {}
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

export async function saveSecureRunnerCredentials(credentials: SecureRunnerCredentials) {
  await Promise.all([
    write(RUNNER_TOKEN_KEY, credentials.runnerToken),
    write(CF_ACCESS_CLIENT_ID_KEY, credentials.cloudflareAccessClientId),
    write(CF_ACCESS_CLIENT_SECRET_KEY, credentials.cloudflareAccessClientSecret),
  ]);
}
