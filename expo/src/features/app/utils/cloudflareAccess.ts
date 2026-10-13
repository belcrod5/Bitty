export type CloudflareAccessCredentials = {
  clientId: string;
  clientSecret: string;
};

export type CloudflareRunnerPairing = {
  runnerUrl: string;
  localRunnerUrl: string;
  localRunnerCertificate: string;
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

function readString(record: Record<string, unknown>, key: string) {
  return String(record[key] || "").trim();
}

function originWithNormalizedHost(url: URL) {
  return `${url.protocol}//${url.host.toLowerCase()}`;
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
  if (type !== "bitty.runner.pairing") {
    throw new Error(`Unsupported QR payload type: ${type}`);
  }

  const runnerUrl = readString(record, "runnerUrl");
  const localRunnerUrl = readString(record, "localRunnerUrl");
  const localRunnerCertificate = readString(record, "localRunnerCertificate");
  const runnerToken = readString(record, "runnerToken");
  const cloudflareAccessClientId = readString(record, "cloudflareAccessClientId");
  const cloudflareAccessClientSecret = readString(record, "cloudflareAccessClientSecret");

  if (!runnerUrl) throw new Error("QR payload is missing runnerUrl");
  if (!runnerToken) throw new Error("QR payload is missing runnerToken");
  if (!cloudflareAccessClientId) {
    throw new Error("QR payload is missing Cloudflare Access client id");
  }
  if (!cloudflareAccessClientSecret) {
    throw new Error("QR payload is missing Cloudflare Access client secret");
  }

  let parsedRunnerUrl: URL;
  let parsedLocalRunnerUrl: URL | null = null;
  try {
    parsedRunnerUrl = new URL(runnerUrl);
    parsedLocalRunnerUrl = localRunnerUrl ? new URL(localRunnerUrl) : null;
  } catch {
    throw new Error("QR payload has an invalid runner URL");
  }
  if (
    parsedRunnerUrl.protocol !== "https:" ||
    parsedRunnerUrl.username ||
    parsedRunnerUrl.password ||
    parsedRunnerUrl.search ||
    parsedRunnerUrl.hash || parsedRunnerUrl.pathname !== "/"
  ) {
    throw new Error("Pairing requires an HTTPS runner origin");
  }
  if (parsedLocalRunnerUrl) {
    if (
      !["http:", "https:"].includes(parsedLocalRunnerUrl.protocol) ||
      parsedLocalRunnerUrl.username ||
      parsedLocalRunnerUrl.password ||
      parsedLocalRunnerUrl.search ||
      parsedLocalRunnerUrl.hash || parsedLocalRunnerUrl.pathname !== "/"
    ) {
      throw new Error("Pairing local runner requires an HTTPS origin");
    }
  }

  return {
    runnerUrl: originWithNormalizedHost(parsedRunnerUrl),
    // Legacy plaintext QR remains usable for the Tunnel, but cannot enable LAN.
    localRunnerUrl: parsedLocalRunnerUrl?.protocol === "https:" && localRunnerCertificate
      ? originWithNormalizedHost(parsedLocalRunnerUrl) : "",
    localRunnerCertificate: parsedLocalRunnerUrl?.protocol === "https:" ? localRunnerCertificate : "",
    runnerToken,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
  };
}
