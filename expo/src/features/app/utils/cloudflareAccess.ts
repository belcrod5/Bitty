export type CloudflareAccessCredentials = {
  clientId: string;
  clientSecret: string;
};

export type CloudflareRunnerPairing = {
  runnerUrl: string;
  runnerWsUrl: string;
  localRunnerUrl: string;
  localRunnerWsUrl: string;
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

function sameHost(a: URL, b: URL) {
  return a.host.toLowerCase() === b.host.toLowerCase();
}

function originWithNormalizedHost(url: URL) {
  return `${url.protocol}//${url.host.toLowerCase()}`;
}

function endpointWithNormalizedHost(url: URL) {
  return `${originWithNormalizedHost(url)}${url.pathname}`;
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
  const localRunnerUrl = readString(record, ["localRunnerUrl", "localUrl"]);
  const localRunnerWsUrl = readString(record, ["localRunnerWsUrl", "localWsUrl"]);
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
  let parsedLocalRunnerUrl: URL | null = null;
  let parsedLocalRunnerWsUrl: URL | null = null;
  try {
    parsedRunnerUrl = new URL(runnerUrl);
    parsedRunnerWsUrl = new URL(runnerWsUrl);
    parsedLocalRunnerUrl = localRunnerUrl ? new URL(localRunnerUrl) : null;
    parsedLocalRunnerWsUrl = localRunnerWsUrl ? new URL(localRunnerWsUrl) : null;
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
    !sameHost(parsedRunnerWsUrl, parsedRunnerUrl) ||
    parsedRunnerWsUrl.pathname !== "/runner-ws" ||
    parsedRunnerWsUrl.search ||
    parsedRunnerWsUrl.hash
  ) {
    throw new Error("Pairing requires a same-origin WSS runner endpoint");
  }
  if (parsedLocalRunnerUrl || parsedLocalRunnerWsUrl) {
    if (!parsedLocalRunnerUrl || !parsedLocalRunnerWsUrl) {
      throw new Error("Pairing local runner requires both local HTTP and WS endpoints");
    }
    if (
      parsedLocalRunnerUrl.protocol !== "http:" ||
      parsedLocalRunnerUrl.username ||
      parsedLocalRunnerUrl.password ||
      parsedLocalRunnerUrl.search ||
      parsedLocalRunnerUrl.hash
    ) {
      throw new Error("Pairing local runner requires an HTTP origin");
    }
    if (
      parsedLocalRunnerWsUrl.protocol !== "ws:" ||
      parsedLocalRunnerWsUrl.username ||
      parsedLocalRunnerWsUrl.password ||
      !sameHost(parsedLocalRunnerWsUrl, parsedLocalRunnerUrl) ||
      parsedLocalRunnerWsUrl.pathname !== "/runner-ws" ||
      parsedLocalRunnerWsUrl.search ||
      parsedLocalRunnerWsUrl.hash
    ) {
      throw new Error("Pairing local runner requires a same-origin WS endpoint");
    }
  }

  return {
    runnerUrl: originWithNormalizedHost(parsedRunnerUrl),
    runnerWsUrl: endpointWithNormalizedHost(parsedRunnerWsUrl),
    localRunnerUrl: parsedLocalRunnerUrl ? originWithNormalizedHost(parsedLocalRunnerUrl) : "",
    localRunnerWsUrl: parsedLocalRunnerWsUrl ? endpointWithNormalizedHost(parsedLocalRunnerWsUrl) : "",
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
  };
}
