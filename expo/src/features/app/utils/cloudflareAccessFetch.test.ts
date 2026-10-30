import { configureCloudflareAccessFetch } from "./cloudflareAccessFetch";
import { getNetworkUsageSnapshot, resetNetworkUsage } from "../../ws/networkUsageMetrics";

test("fetch usage keeps the request's Runner origin across a route switch and counts transfer length", async () => {
  const originalFetch = globalThis.fetch;
  let resolveResponse!: (response: Response) => void;
  globalThis.fetch = jest.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  const credentials = { clientId: "", clientSecret: "" };
  resetNetworkUsage();
  try {
    configureCloudflareAccessFetch({ runnerUrl: "https://first.test", credentials });
    const first = fetch("https://first.test/client-state", { method: "POST", body: "request" });
    configureCloudflareAccessFetch({ runnerUrl: "https://second.test", credentials });
    resolveResponse({ headers: { get: (name: string) => name === "content-length" ? "123" : null } } as Response);
    await first;
    expect(getNetworkUsageSnapshot().httpByCategory["client-state"])
      .toEqual({ sentBytes: 7, receivedBytes: 123 });
    const otherOrigin = fetch("https://first.test/client-state");
    resolveResponse({ headers: { get: (name: string) => name === "content-length" ? "456" : null } } as Response);
    await otherOrigin;
    expect(getNetworkUsageSnapshot().httpByCategory["other-origin"])
      .toEqual({ sentBytes: 0, receivedBytes: 456 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
