import * as SecureStore from "expo-secure-store";
import { isRunnerSessionToken } from "./runnerLogin";
import { persistedCloudflareRunnerUrl, runnerDevelopmentOrigin, runnerHttpsOrigin } from "./urlResolvers";

export type SecureRunnerCredentials = {
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
};
export type RunnerCredentialScope = { cloudflareOrigin: string; localOrigin: string };
type CredentialRecord = SecureRunnerCredentials & { version: 3; scope: RunnerCredentialScope };
const KEY = "bitty.runnerCredentials.v3";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  authenticationPrompt: "Runner認証情報を使用するため、キーチェーンへのアクセスを許可してください。",
};
const EMPTY: SecureRunnerCredentials = { runnerToken: "", cloudflareAccessClientId: "", cloudflareAccessClientSecret: "" };
const FIELDS = ["runnerToken", "cloudflareAccessClientId", "cloudflareAccessClientSecret"] as const;
let credentialRevision = 0;

// Both transports belong to one paired Runner. Selecting LAN instead of Tunnel
// changes neither this identity nor the credential record.
export function runnerCredentialScope(settings: Record<string, unknown>): RunnerCredentialScope | null {
  const cloudflareRaw = persistedCloudflareRunnerUrl(settings);
  const cloudflareOrigin = runnerHttpsOrigin(cloudflareRaw);
  const localRaw = String(settings.localRunnerUrl || "").trim();
  const localOrigin = runnerHttpsOrigin(localRaw) || runnerDevelopmentOrigin(localRaw)
    || (!cloudflareOrigin ? runnerDevelopmentOrigin(settings.runnerUrl) : "");
  const selected = runnerHttpsOrigin(settings.runnerUrl) || runnerDevelopmentOrigin(settings.runnerUrl);
  if ((cloudflareRaw && !cloudflareOrigin) || (localRaw && !localOrigin) ||
    (!cloudflareOrigin && !localOrigin) || (selected && selected !== cloudflareOrigin && selected !== localOrigin)) return null;
  return { cloudflareOrigin, localOrigin };
}
function sameScope(left: RunnerCredentialScope, right: RunnerCredentialScope) {
  return left.cloudflareOrigin === right.cloudflareOrigin && left.localOrigin === right.localOrigin;
}
async function readRecord(): Promise<{ raw: string | null; record: CredentialRecord | null }> {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (!raw) return { raw: null, record: null };
  let record: CredentialRecord;
  try { record = JSON.parse(raw) as CredentialRecord; }
  catch { throw new Error("invalid_runner_credentials"); }
  if (!record || record.version !== 3 || !record.scope || typeof record.scope.cloudflareOrigin !== "string" ||
    typeof record.scope.localOrigin !== "string" || FIELDS.some((field) => typeof record[field] !== "string") ||
    (record.runnerToken && !isRunnerSessionToken(record.runnerToken))) throw new Error("invalid_runner_credentials");
  return { raw, record };
}

export async function loadSecureRunnerCredentials(scope: RunnerCredentialScope | null = null): Promise<SecureRunnerCredentials> {
  const revision = credentialRevision;
  const { record } = await readRecord();
  if (revision !== credentialRevision || !scope || !record || !sameScope(scope, record.scope)) return { ...EMPTY };
  return { runnerToken: record.runnerToken, cloudflareAccessClientId: record.cloudflareAccessClientId,
    cloudflareAccessClientSecret: record.cloudflareAccessClientSecret };
}

// A single Keychain item commits secrets together with their permitted origins.
// A crash before the separate settings write yields a mismatch, never a credential
// silently attached to another Runner. Saves and conditional expiry cleanup share
// this queue so a stale 401 cannot erase a newer login.
let credentialWrite = Promise.resolve();
export function saveSecureRunnerCredentials(credentials: Partial<SecureRunnerCredentials>, scope?: RunnerCredentialScope | null) {
  credentialRevision += 1;
  const operation = credentialWrite.then(async () => {
    const previous = await readRecord();
    const fields = FIELDS.filter((field) => typeof credentials[field] === "string");
    if (credentials.runnerToken && !isRunnerSessionToken(credentials.runnerToken.trim())) throw new Error("runner_session_required");
    if (!scope && fields.some((field) => credentials[field]?.trim())) throw new Error("runner_configuration_required");
    const targetScope = scope || previous.record?.scope;
    if (!targetScope) {
      if (fields.every((field) => !credentials[field]?.trim())) return;
      throw new Error("runner_configuration_required");
    }
    const changedScope = previous.record && !sameScope(targetScope, previous.record.scope);
    if (changedScope && credentials.runnerToken && FIELDS.some((field) => previous.record?.[field])) {
      throw new Error("runner_configuration_changed");
    }
    const next: CredentialRecord = { ...(changedScope ? EMPTY : previous.record || EMPTY), version: 3, scope: targetScope };
    for (const field of fields) next[field] = String(credentials[field] || "").trim();
    const raw = JSON.stringify(next);
    try {
      await SecureStore.setItemAsync(KEY, raw, OPTIONS);
      if (await SecureStore.getItemAsync(KEY, OPTIONS) !== raw) throw new Error("secure_credentials_readback_mismatch");
    } catch (reason) {
      try {
        if (previous.raw) await SecureStore.setItemAsync(KEY, previous.raw, OPTIONS);
        else await SecureStore.deleteItemAsync(KEY, OPTIONS);
        if ((await SecureStore.getItemAsync(KEY, OPTIONS) || null) !== previous.raw) throw new Error("rollback mismatch");
      } catch { throw new Error("secure_credentials_rollback_failed"); }
      throw reason;
    }
  });
  credentialWrite = operation.catch(() => undefined);
  return operation;
}
export function clearSecureRunnerSession(expectedToken: string): Promise<boolean> {
  credentialRevision += 1;
  const operation = credentialWrite.then(async () => {
    const { record } = await readRecord();
    if (!record || record.runnerToken !== expectedToken) return false;
    const raw = JSON.stringify({ ...record, runnerToken: "" });
    await SecureStore.setItemAsync(KEY, raw, OPTIONS);
    if (await SecureStore.getItemAsync(KEY, OPTIONS) !== raw) throw new Error("secure_credentials_readback_mismatch");
    return true;
  });
  credentialWrite = operation.then(() => undefined, () => undefined);
  return operation;
}
