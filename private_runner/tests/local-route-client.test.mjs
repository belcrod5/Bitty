import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_TOKEN = "test-token";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PRIVATE_RUNNER_DIR = path.join(REPO_ROOT, "private_runner");

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildHealthUrl(runnerUrl) {
  const normalized = trimTrailingSlash(runnerUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function probeLocalRunnerRoute({
  localRunnerUrl,
  cloudflareRunnerUrl,
  runnerToken,
  fetchImpl = fetch,
  timeoutMs = 2500,
}) {
  const localUrl = trimTrailingSlash(localRunnerUrl);
  const cloudflareUrl = trimTrailingSlash(cloudflareRunnerUrl);
  const healthUrl = buildHealthUrl(localUrl);
  const token = String(runnerToken || "").trim();
  if (!healthUrl || !cloudflareUrl || !token) {
    return {
      selectedRoute: "cloudflare",
      runnerUrl: cloudflareUrl,
      localReachable: false,
      error: "missing_config",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const localReachable = response.ok;
    return {
      selectedRoute: localReachable ? "local" : "cloudflare",
      runnerUrl: localReachable ? localUrl : cloudflareUrl,
      localReachable,
      status: response.status,
    };
  } catch (err) {
    return {
      selectedRoute: "cloudflare",
      runnerUrl: cloudflareUrl,
      localReachable: false,
      error: err?.name === "AbortError" ? "timeout" : "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function withHealthServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function loadPrivateRunnerEnv() {
  const envPath = path.join(PRIVATE_RUNNER_DIR, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function normalizeLocalHttpUrl(raw) {
  const value = trimTrailingSlash(raw);
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return "";
  }
}

function readMacLocalHostName() {
  const configured = String(process.env.RUNNER_LOCAL_HOSTNAME || "").trim();
  if (configured) {
    return { value: configured.replace(/\.local$/i, ""), source: "RUNNER_LOCAL_HOSTNAME" };
  }
  if (process.platform !== "darwin") return { value: "", source: "unsupported_platform" };
  const result = spawnSync("scutil", ["--get", "LocalHostName"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return { value: "", source: "scutil_failed" };
  return {
    value: String(result.stdout || "").trim().replace(/\.local$/i, ""),
    source: "scutil LocalHostName",
  };
}

function resolveConfiguredLocalRunnerUrl() {
  const configured = normalizeLocalHttpUrl(process.env.RUNNER_LOCAL_URL);
  if (configured) {
    return {
      localHostName: "",
      localHostNameSource: "RUNNER_LOCAL_URL",
      localRunnerUrl: configured,
      localRunnerUrlSource: "RUNNER_LOCAL_URL",
    };
  }
  const { value: localHostName, source: localHostNameSource } = readMacLocalHostName();
  if (!localHostName || /[/\s:]/.test(localHostName)) return "";
  const port = String(
    process.env.RUNNER_LOCAL_PORT || process.env.RUNNER_PORT || process.env.PORT || "8788"
  ).trim();
  if (!/^\d+$/.test(port)) return "";
  return {
    localHostName,
    localHostNameSource,
    localRunnerUrl: `http://${localHostName}.local:${port}`,
    localRunnerUrlSource: "LocalHostName.local",
  };
}

function resolveTokenFilePath(rawPath) {
  const tokenPath = String(rawPath || "private_runner/logs/runner-token").trim();
  if (!tokenPath) return "";
  if (path.isAbsolute(tokenPath)) return tokenPath;

  const repoRelative = path.resolve(REPO_ROOT, tokenPath);
  if (existsSync(repoRelative)) return repoRelative;
  return path.resolve(PRIVATE_RUNNER_DIR, tokenPath);
}

function readConfiguredRunnerToken() {
  const tokenFile = resolveTokenFilePath(process.env.RUNNER_TOKEN_FILE);
  if (tokenFile && existsSync(tokenFile)) {
    const fileToken = String(readFileSync(tokenFile, "utf8") || "").trim();
    if (fileToken) return fileToken;
  }
  return String(process.env.RUNNER_TOKEN || "").trim();
}

test("client route probe selects local when local /health succeeds", async () => {
  let requestCount = 0;

  await withHealthServer((req, res) => {
    requestCount += 1;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/health");
    assert.equal(req.headers.authorization, `Bearer ${TEST_TOKEN}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (localRunnerUrl) => {
    const result = await probeLocalRunnerRoute({
      localRunnerUrl,
      cloudflareRunnerUrl: "https://runner.example.test",
      runnerToken: TEST_TOKEN,
    });

    assert.equal(requestCount, 1);
    assert.equal(result.selectedRoute, "local");
    assert.equal(result.runnerUrl, localRunnerUrl);
    assert.equal(result.localReachable, true);
    assert.equal(result.status, 200);
  });
});

test("client route probe falls back to Cloudflare when local /health fails", async () => {
  let requestCount = 0;

  await withHealthServer((_req, res) => {
    requestCount += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  }, async (localRunnerUrl) => {
    const result = await probeLocalRunnerRoute({
      localRunnerUrl,
      cloudflareRunnerUrl: "https://runner.example.test",
      runnerToken: TEST_TOKEN,
    });

    assert.equal(requestCount, 1);
    assert.equal(result.selectedRoute, "cloudflare");
    assert.equal(result.runnerUrl, "https://runner.example.test");
    assert.equal(result.localReachable, false);
    assert.equal(result.status, 503);
  });
});

test(
  "live client route probe reaches configured local runner",
  { skip: process.env.RUNNER_ROUTE_LIVE_TEST !== "1" },
  async () => {
    loadPrivateRunnerEnv();

    const localRouteConfig = resolveConfiguredLocalRunnerUrl();
    const localRunnerUrl = localRouteConfig.localRunnerUrl;
    const runnerToken = readConfiguredRunnerToken();
    assert.ok(localRunnerUrl, "RUNNER_LOCAL_URL or macOS LocalHostName.local is required");
    assert.ok(runnerToken, "RUNNER_TOKEN_FILE or RUNNER_TOKEN is required");
    const healthUrl = buildHealthUrl(localRunnerUrl);

    const result = await probeLocalRunnerRoute({
      localRunnerUrl,
      cloudflareRunnerUrl: "https://runner.example.test",
      runnerToken,
    });

    console.log("[local-route-client-test] local route config");
    console.log(`  localHostName=${localRouteConfig.localHostName || "(not used)"}`);
    console.log(`  localHostNameSource=${localRouteConfig.localHostNameSource}`);
    console.log(`  localRunnerUrlSource=${localRouteConfig.localRunnerUrlSource}`);
    console.log(`  localRunnerUrl=${localRunnerUrl}`);
    console.log(`  healthUrl=${healthUrl}`);
    console.log(`  selectedRoute=${result.selectedRoute}`);
    console.log(`  httpStatus=${result.status ?? ""}`);
    console.log(`  error=${result.error ?? ""}`);
    assert.equal(result.selectedRoute, "local");
    assert.equal(result.localReachable, true);
  }
);
