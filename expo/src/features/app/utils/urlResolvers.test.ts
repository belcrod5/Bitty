import { persistedCloudflareRunnerUrl, resolveRunnerUrl, runnerHttpsOrigin, suggestRunnerWsUrlFromRunnerUrl } from "./urlResolvers";

test("runner websocket URL suggestions do not put tokens in query strings", () => {
  expect(suggestRunnerWsUrlFromRunnerUrl("https://bitty-runner.example.com")).toBe(
    "wss://bitty-runner.example.com/runner-ws"
  );
});

test("saved plaintext LAN selection can only fall back to secure Tunnel", () => {
  const urls = { runnerUrl: "http://192.168.1.1:8788", localRunnerUrl: "http://192.168.1.1:8788",
    cloudflareRunnerUrl: "https://runner.example.com" };
  expect(resolveRunnerUrl(urls)).toBe(urls.cloudflareRunnerUrl);
  expect(resolveRunnerUrl({ ...urls, cloudflareRunnerUrl: "" })).toBe("");
  expect(resolveRunnerUrl({ runnerUrl: "http://mac.local:8788" })).toBe("");
  expect(resolveRunnerUrl({ runnerUrl: "http://127.0.0.1:8788" })).toBe("http://127.0.0.1:8788");
});

test("saved local HTTPS cannot win before native paired trust is ready", () => {
  const urls = { runnerUrl: "https://mac.local:8789", localRunnerUrl: "https://mac.local:8789",
    cloudflareRunnerUrl: "https://runner.example.com" };
  expect(resolveRunnerUrl(urls)).toBe(urls.cloudflareRunnerUrl);
  expect(resolveRunnerUrl({ ...urls, localReady: true })).toBe(urls.localRunnerUrl);
  expect(resolveRunnerUrl({ ...urls, cloudflareRunnerUrl: "", localReady: false })).toBe("");
});

test("invalid explicit Tunnel never falls back to previously selected HTTP or HTTPS", () => {
  for (const invalid of ["http://runner.example.com", "not-a-url", "https://runner.example.com/path", "https://user@runner.example.com"]) {
    expect(resolveRunnerUrl({ runnerUrl: "http://127.0.0.1:8788", cloudflareRunnerUrl: invalid })).toBe("");
    expect(resolveRunnerUrl({ runnerUrl: "https://mac.local:8789", cloudflareRunnerUrl: invalid, localReady: true })).toBe("");
  }
});

test("persisted Tunnel migration cannot mistake selected local HTTPS for Cloudflare", () => {
  expect(persistedCloudflareRunnerUrl({ runnerUrl: "https://mac.local:8789", localRunnerUrl: "https://mac.local:8789" })).toBe("");
  expect(persistedCloudflareRunnerUrl({ runnerUrl: "https://runner.example.com" })).toBe("https://runner.example.com");
  expect(runnerHttpsOrigin("https://mac.local:8789?token=x")).toBe("");
});
