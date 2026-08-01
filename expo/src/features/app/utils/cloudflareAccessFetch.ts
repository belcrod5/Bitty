import {
  buildCloudflareAccessHeaders,
  normalizeCloudflareAccessCredentials,
  type CloudflareAccessCredentials,
} from "./cloudflareAccess";
import { recordHttpNetworkUsage, utf8ByteLength } from "../../ws/networkUsageMetrics";

type FetchPatchConfig = {
  runnerUrl: string;
  credentials: CloudflareAccessCredentials;
};

let installed = false;
let originalFetch: typeof fetch | null = null;
let activeRunnerOrigin = "";
let activeHeaders: Record<string, string> = {};

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
  if (!activeRunnerOrigin || !activeHeaders["CF-Access-Client-Id"] || !activeHeaders["CF-Access-Client-Secret"]) {
    return false;
  }
  const url = requestUrl(input);
  if (!url) return false;
  return normalizeOrigin(url) === activeRunnerOrigin;
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

function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === "string") return utf8ByteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  const maybeBlobSize = (body as { size?: unknown }).size;
  return typeof maybeBlobSize === "number" && Number.isFinite(maybeBlobSize) ? maybeBlobSize : 0;
}

function recordHttpResponseUsage(url: string, response: Response) {
  const headers = response?.headers;
  const contentLength = Number(headers?.get?.("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    recordHttpNetworkUsage(url, 0, contentLength);
    return;
  }
  // /session-messages はサーバーが応答バイト数をヘッダで報告している。
  const reportedBytes = Number(headers?.get?.("x-session-messages-response-bytes") || 0);
  if (Number.isFinite(reportedBytes) && reportedBytes > 0) {
    recordHttpNetworkUsage(url, 0, reportedBytes);
    return;
  }
  try {
    response.clone().arrayBuffer()
      .then((buffer) => recordHttpNetworkUsage(url, 0, buffer.byteLength))
      .catch(() => undefined);
  } catch {
    // clone不可(既に消費済み等)の応答は未計上のまま許容する。
  }
}

export function configureCloudflareAccessFetch(config: FetchPatchConfig) {
  activeRunnerOrigin = normalizeOrigin(config.runnerUrl);
  activeHeaders = buildCloudflareAccessHeaders(normalizeCloudflareAccessCredentials(
    config.credentials.clientId,
    config.credentials.clientSecret
  ));

  if (installed) return;
  if (typeof fetch !== "function") return;

  originalFetch = fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!originalFetch) return fetch(input, init);
    const finalInit = shouldAttachCloudflareAccessHeaders(input)
      ? { ...(init || {}), headers: mergeHeaders(init?.headers, activeHeaders) }
      : init;
    const responsePromise = originalFetch(input, finalInit);
    const url = requestUrl(input);
    recordHttpNetworkUsage(url, requestBodyBytes(finalInit?.body), 0);
    responsePromise.then(
      (response) => recordHttpResponseUsage(url, response),
      () => undefined
    );
    return responsePromise;
  }) as typeof fetch;
  installed = true;
}

export function getCloudflareAccessHeadersForUrl(url: string) {
  if (!shouldAttachCloudflareAccessHeaders(url)) return {};
  return activeHeaders;
}
