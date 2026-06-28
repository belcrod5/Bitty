import {
  buildCloudflareAccessHeaders,
  normalizeCloudflareAccessCredentials,
  type CloudflareAccessCredentials,
} from "./cloudflareAccess";

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
    if (!originalFetch || !shouldAttachCloudflareAccessHeaders(input)) {
      return originalFetch ? originalFetch(input, init) : fetch(input, init);
    }
    return originalFetch(input, {
      ...(init || {}),
      headers: mergeHeaders(init?.headers, activeHeaders),
    });
  }) as typeof fetch;
  installed = true;
}

export function getCloudflareAccessHeadersForUrl(url: string) {
  if (!shouldAttachCloudflareAccessHeaders(url)) return {};
  return activeHeaders;
}
