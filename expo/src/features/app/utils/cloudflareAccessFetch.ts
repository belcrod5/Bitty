import {
  buildCloudflareAccessHeaders,
  normalizeCloudflareAccessCredentials,
  type CloudflareAccessCredentials,
} from "./cloudflareAccess";
import { recordHttpNetworkUsage, utf8ByteLength } from "../../ws/networkUsageMetrics";

type FetchPatchConfig = {
  runnerUrl: string;
  cloudflareRunnerUrl: string;
  credentials: CloudflareAccessCredentials;
  sessionToken?: string;
  onSessionInvalid?: (token: string) => void;
};

let installed = false;
let originalFetch: typeof fetch | null = null;
let activeRunnerOrigin = "";
let cloudflareAccessOrigin = "";
let activeHeaders: Record<string, string> = {};
let pendingHttpMeasurements = 0;
let sessionToken = "";
let onSessionInvalid: FetchPatchConfig["onSessionInvalid"];

export function getPendingHttpNetworkMeasurements() {
  return pendingHttpMeasurements;
}

function normalizeOrigin(rawUrl: string) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    return url.origin;
  } catch {
    return "";
  }
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  const maybeUrl = (input as { url?: unknown })?.url;
  return typeof maybeUrl === "string" ? maybeUrl : "";
}

function shouldAttachCloudflareAccessHeaders(input: RequestInfo | URL) {
  if (!cloudflareAccessOrigin || !activeHeaders["CF-Access-Client-Id"] || !activeHeaders["CF-Access-Client-Secret"]) {
    return false;
  }
  const url = requestUrl(input);
  if (!url) return false;
  return normalizeOrigin(url) === cloudflareAccessOrigin;
}

function mergeHeaders(headers: HeadersInit | undefined, extra: Record<string, string>) {
  const next = new Headers(headers || {});
  for (const [key, value] of Object.entries(extra)) {
    if (value && !next.has(key)) {
      next.set(key, value);
    }
  }
  return next;
}

// RNのFormDataは _parts に [name, value] を保持する。valueは文字列またはファイルパート
// ({uri, name, type, size?})。ファイルパートの実体サイズは同期的には取れないため、
// 呼び出し元が付与した size を使う下限推定(multipart境界・パートヘッダは含まない)。
function formDataPartsBytes(parts: unknown[]): number {
  let bytes = 0;
  for (const part of parts) {
    if (!Array.isArray(part)) continue;
    const value = part[1];
    if (typeof value === "string") {
      bytes += utf8ByteLength(value);
      continue;
    }
    if (value && typeof value === "object") {
      const size = Number((value as { size?: unknown }).size);
      if (Number.isFinite(size) && size > 0) bytes += size;
    }
  }
  return bytes;
}

function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === "string") return utf8ByteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  const maybeParts = (body as { _parts?: unknown })._parts;
  if (Array.isArray(maybeParts)) return formDataPartsBytes(maybeParts);
  const maybeBlobSize = (body as { size?: unknown }).size;
  return typeof maybeBlobSize === "number" && Number.isFinite(maybeBlobSize) ? maybeBlobSize : 0;
}

async function recordHttpResponseUsage(url: string, response: Response, runnerOrigin: string) {
  const headers = response?.headers;
  const contentLength = Number(headers?.get?.("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    recordHttpNetworkUsage(url, 0, contentLength, runnerOrigin);
    return;
  }
  // /session-messages はサーバーが応答バイト数をヘッダで報告している。
  const reportedBytes = Number(headers?.get?.("x-session-messages-response-bytes") || 0);
  if (Number.isFinite(reportedBytes) && reportedBytes > 0) {
    recordHttpNetworkUsage(url, 0, reportedBytes, runnerOrigin);
    return;
  }
  try {
    const buffer = await response.clone().arrayBuffer();
    recordHttpNetworkUsage(url, 0, buffer.byteLength, runnerOrigin);
  } catch {
    // clone不可(既に消費済み等)の応答は未計上のまま許容する。
  }
}

export function configureCloudflareAccessFetch(config: FetchPatchConfig) {
  activeRunnerOrigin = normalizeOrigin(config.runnerUrl);
  cloudflareAccessOrigin = normalizeOrigin(config.cloudflareRunnerUrl);
  activeHeaders = buildCloudflareAccessHeaders(normalizeCloudflareAccessCredentials(
    config.credentials.clientId,
    config.credentials.clientSecret
  ));
  sessionToken = config.sessionToken || "";
  onSessionInvalid = config.onSessionInvalid;

  if (installed) return;
  if (typeof fetch !== "function") return;

  originalFetch = fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!originalFetch) return fetch(input, init);
    const inputHeaders = typeof input === "object" && "headers" in input ? input.headers : undefined;
    let finalInit = shouldAttachCloudflareAccessHeaders(input)
      ? { ...(init || {}), headers: mergeHeaders(init?.headers || inputHeaders, activeHeaders) }
      : init;
    const sentHeaders = new Headers(finalInit?.headers || inputHeaders);
    const sentToken = sentHeaders.get("authorization")?.replace(/^Bearer /, "") || "";
    const requestOrigin = normalizeOrigin(requestUrl(input));
    if ([activeRunnerOrigin, cloudflareAccessOrigin].includes(requestOrigin) &&
      (sentToken || sentHeaders.has("CF-Access-Client-Secret"))) finalInit = { ...finalInit, redirect: "error" };
    const responsePromise = originalFetch(input, finalInit);
    void responsePromise.then(async (response) => {
      if (response.status !== 401 || !sentToken || sentToken !== sessionToken ||
        ![activeRunnerOrigin, cloudflareAccessOrigin].includes(requestOrigin)) return;
      const path = new URL(requestUrl(input)).pathname;
      if (path.startsWith("/auth/") && path !== "/auth/session") return;
      const body = await response.clone().json().catch(() => null);
      // Cloudflare login errors and stale requests must not erase a valid session.
      if (body?.error === "authentication_required" && sentToken === sessionToken) onSessionInvalid?.(sentToken);
    }).catch(() => undefined);
    pendingHttpMeasurements += 1;
    try {
      const url = requestUrl(input);
      const runnerOrigin = activeRunnerOrigin;
      recordHttpNetworkUsage(url, requestBodyBytes(finalInit?.body), 0, runnerOrigin);
      void responsePromise.then((response) => recordHttpResponseUsage(url, response, runnerOrigin))
        .catch(() => undefined)
        .finally(() => { pendingHttpMeasurements -= 1; });
    } catch {
      // 計測失敗は通信本体に影響させない。
      pendingHttpMeasurements -= 1;
    }
    return responsePromise;
  }) as typeof fetch;
  installed = true;
}

export function getCloudflareAccessHeadersForUrl(url: string) {
  if (!shouldAttachCloudflareAccessHeaders(url)) return {};
  return activeHeaders;
}

// Native media downloads bypass the JS fetch patch. Limit both credentials to
// configured Runner origins; file/external URLs must remain credential-free.
export function getRunnerMediaHeadersForUrl(url: string): Record<string, string> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return {}; }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password ||
    ![activeRunnerOrigin, cloudflareAccessOrigin].filter(Boolean).includes(parsed.origin)) return {};
  return {
    ...getCloudflareAccessHeadersForUrl(url),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };
}
