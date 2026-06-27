export type CloudflareAccessCredentials = {
  clientId: string;
  clientSecret: string;
};

export type CloudflareRunnerPairing = {
  runnerUrl: string;
  runnerWsUrl: string;
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessClientSecret: string;
};

export function normalizeCloudflareAccessCredentials(
  clientIdRaw: unknown,
  clientSecretRaw: unknown
): CloudflareAccessCredentials {
  return {
    clientId: String(clientIdRaw || "").trim(),
    clientSecret: String(clientSecretRaw || "").trim(),
  };
}

export function buildCloudflareAccessHeaders(credentials: CloudflareAccessCredentials): Record<string, string> {
  if (!credentials.clientId || !credentials.clientSecret) return {};
  const headers: Record<string, string> = {
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  };
  return headers;
}

export function hasCloudflareAccessCredentials(credentials: CloudflareAccessCredentials) {
  return !!credentials.clientId && !!credentials.clientSecret;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = String(record[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function parseCloudflareRunnerPairingPayload(raw: string): CloudflareRunnerPairing {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("QR payload is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("QR payload is not JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QR payload must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const type = String(record.type || "").trim();
  if (type && type !== "bitty.runner.pairing") {
    throw new Error(`Unsupported QR payload type: ${type}`);
  }

  const runnerUrl = readString(record, ["runnerUrl", "url", "baseUrl"]);
  const runnerWsUrl = readString(record, ["runnerWsUrl", "wsUrl"]);
  const runnerToken = readString(record, ["runnerToken", "token"]);
  const cloudflareAccessClientId = readString(record, [
    "cloudflareAccessClientId",
    "cfAccessClientId",
    "cfClientId",
  ]);
  const cloudflareAccessClientSecret = readString(record, [
    "cloudflareAccessClientSecret",
    "cfAccessClientSecret",
    "cfClientSecret",
  ]);

  if (!runnerUrl) throw new Error("QR payload is missing runnerUrl");
  if (!runnerToken) throw new Error("QR payload is missing runnerToken");
  if (!cloudflareAccessClientId) {
    throw new Error("QR payload is missing Cloudflare Access client id");
  }
  if (!cloudflareAccessClientSecret) {
    throw new Error("QR payload is missing Cloudflare Access client secret");
  }

  let parsedRunnerUrl: URL;
  let parsedRunnerWsUrl: URL;
  try {
    parsedRunnerUrl = new URL(runnerUrl);
    parsedRunnerWsUrl = new URL(runnerWsUrl);
  } catch {
    throw new Error("QR payload has an invalid runner URL");
  }
  if (
    parsedRunnerUrl.protocol !== "https:" ||
    parsedRunnerUrl.username ||
    parsedRunnerUrl.password ||
    parsedRunnerUrl.search ||
    parsedRunnerUrl.hash
  ) {
    throw new Error("Pairing requires an HTTPS runner origin");
  }
  if (
    parsedRunnerWsUrl.protocol !== "wss:" ||
    parsedRunnerWsUrl.username ||
    parsedRunnerWsUrl.password ||
    parsedRunnerWsUrl.host !== parsedRunnerUrl.host ||
    parsedRunnerWsUrl.pathname !== "/runner-ws" ||
    parsedRunnerWsUrl.search ||
    parsedRunnerWsUrl.hash
  ) {
    throw new Error("Pairing requires a same-origin WSS runner endpoint");
  }

  return {
    runnerUrl: parsedRunnerUrl.origin,
    runnerWsUrl: parsedRunnerWsUrl.toString(),
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
  };
}
