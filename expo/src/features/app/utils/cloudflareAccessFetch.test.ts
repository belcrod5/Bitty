import { configureCloudflareAccessFetch, getCloudflareAccessHeadersForUrl } from "./cloudflareAccessFetch";
import { getNetworkUsageSnapshot, resetNetworkUsage } from "../../ws/networkUsageMetrics";

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn();
const localUrl = "http://local.test:8788";
const cloudflareUrl = "https://cloudflare.test";
const credentials = { clientId: "access-id", clientSecret: "access-secret" };
const response = (bytes: number) => ({
  headers: { get: (name: string) => name === "content-length" ? String(bytes) : null },
}) as Response;

beforeAll(() => { globalThis.fetch = fetchMock; });
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(response(123));
  resetNetworkUsage();
  configureCloudflareAccessFetch({ runnerUrl: localUrl, cloudflareRunnerUrl: cloudflareUrl, credentials });
});
afterAll(() => { globalThis.fetch = originalFetch; });

test.each([
  ["string", () => `${localUrl}/client-state`],
  ["URL", () => new URL(`${localUrl}/client-state`)],
  ["Request", () => new Request(`${localUrl}/client-state`)],
])("counts the selected local Runner for %s input without attaching Cloudflare credentials", async (_kind, input) => {
  await fetch(input());
  expect(getNetworkUsageSnapshot().httpByCategory["client-state"])
    .toEqual({ sentBytes: 0, receivedBytes: 123 });
  expect(fetchMock.mock.calls[0][1]).toBeUndefined();
});

test("Cloudflare credentials remain scoped to Cloudflare while local is selected", async () => {
  await fetch(`${cloudflareUrl}/client-state`, { headers: { "CF-Access-Client-Id": "explicit-id" } });
  const headers = fetchMock.mock.calls[0][1].headers as Headers;
  expect(headers.get("CF-Access-Client-Id")).toBe("explicit-id");
  expect(headers.get("CF-Access-Client-Secret")).toBe(credentials.clientSecret);
  expect(getCloudflareAccessHeadersForUrl(`${cloudflareUrl}/tts-media/audio.mp3`))
    .toEqual({ "CF-Access-Client-Id": credentials.clientId, "CF-Access-Client-Secret": credentials.clientSecret });
  expect(getCloudflareAccessHeadersForUrl(`${localUrl}/tts-media/audio.mp3`)).toEqual({});
  expect(getNetworkUsageSnapshot().httpByCategory["other-origin"].receivedBytes).toBe(123);
});

test("counts selected Cloudflare requests without attaching credentials to an external origin", async () => {
  configureCloudflareAccessFetch({ runnerUrl: cloudflareUrl, cloudflareRunnerUrl: cloudflareUrl, credentials });
  await fetch(new URL(`${cloudflareUrl}/client-state`));
  expect((fetchMock.mock.calls[0][1].headers as Headers).get("CF-Access-Client-Id")).toBe(credentials.clientId);
  expect(getNetworkUsageSnapshot().httpByCategory["client-state"].receivedBytes).toBe(123);
  for (const url of ["https://external.test/client-state", "https://cloudflare.test:9443/client-state"]) {
    await fetch(url);
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1]).toBeUndefined();
    expect(getCloudflareAccessHeadersForUrl(url)).toEqual({});
  }
  expect(getNetworkUsageSnapshot().httpByCategory["other-origin"].receivedBytes).toBe(246);
});

test("keeps in-flight transfer bytes attributed to the request's selected Runner across route changes", async () => {
  let resolveLocal!: (value: Response) => void;
  let resolveCloudflare!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLocal = resolve; }));
  const local = fetch(`${localUrl}/client-state`, { method: "POST", body: "request" });
  configureCloudflareAccessFetch({ runnerUrl: cloudflareUrl, cloudflareRunnerUrl: cloudflareUrl, credentials });
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCloudflare = resolve; }));
  const cloudflare = fetch(`${cloudflareUrl}/session-summaries`);
  configureCloudflareAccessFetch({ runnerUrl: localUrl, cloudflareRunnerUrl: cloudflareUrl, credentials });
  resolveCloudflare(response(456));
  resolveLocal(response(123));
  await Promise.all([local, cloudflare]);
  expect(getNetworkUsageSnapshot().httpByCategory["client-state"])
    .toEqual({ sentBytes: 7, receivedBytes: 123 });
  expect(getNetworkUsageSnapshot().httpByCategory["session-summaries"].receivedBytes).toBe(456);
  expect(getNetworkUsageSnapshot().httpByCategory["other-origin"].receivedBytes).toBe(0);
});

test("tracks the selected Runner even when Cloudflare credentials or URL are unset", async () => {
  configureCloudflareAccessFetch({ runnerUrl: localUrl, cloudflareRunnerUrl: "", credentials: { clientId: "", clientSecret: "" } });
  await fetch(`${localUrl}/client-state`);
  expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  expect(getNetworkUsageSnapshot().httpByCategory["client-state"].receivedBytes).toBe(123);
  configureCloudflareAccessFetch({ runnerUrl: cloudflareUrl, cloudflareRunnerUrl: cloudflareUrl, credentials: { clientId: credentials.clientId, clientSecret: "" } });
  await fetch(`${cloudflareUrl}/client-state`);
  expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  expect(getCloudflareAccessHeadersForUrl(`${cloudflareUrl}/client-state`)).toEqual({});
  expect(getNetworkUsageSnapshot().httpByCategory["client-state"].receivedBytes).toBe(246);
});
