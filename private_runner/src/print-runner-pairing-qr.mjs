import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import qrcode from "qrcode-terminal";

function readKeychain(service) {
  if (!service || process.platform !== "darwin") return "";
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function readEnvOrKeychain(envName, serviceName) {
  return String(process.env[envName] || "").trim() || readKeychain(serviceName);
}

function readToken() {
  const tokenFile = String(process.env.RUNNER_TOKEN_FILE || "").trim();
  if (tokenFile) {
    try {
      const fileToken = String(readFileSync(tokenFile, "utf8") || "").trim();
      if (fileToken) return fileToken;
    } catch {}
  }
  return String(process.env.RUNNER_TOKEN || "").trim();
}

function normalizeHttpUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function buildRunnerWsUrl(runnerUrl) {
  try {
    const url = new URL(runnerUrl);
    url.protocol = "wss:";
    url.pathname = "/runner-ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

const runnerUrl = normalizeHttpUrl(
  process.env.RUNNER_PUBLIC_URL || process.env.CLOUDFLARE_RUNNER_PUBLIC_URL
);
const runnerToken = readToken();
const cloudflareAccessClientId = readEnvOrKeychain(
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  process.env.CLOUDFLARE_ACCESS_CLIENT_ID_KEYCHAIN_SERVICE || "bitty-cloudflare-access-client-id"
);
const cloudflareAccessClientSecret = readEnvOrKeychain(
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET_KEYCHAIN_SERVICE || "bitty-cloudflare-access-client-secret"
);

if (!runnerUrl) {
  console.error("[pairing-qr] RUNNER_PUBLIC_URL must be an HTTPS origin to print the Expo pairing QR");
  process.exit(0);
}
if (!runnerToken) {
  console.error("[pairing-qr] RUNNER_TOKEN is required to print the Expo pairing QR");
  process.exit(0);
}
if (!cloudflareAccessClientId || !cloudflareAccessClientSecret) {
  console.error("[pairing-qr] Cloudflare Access service token credentials are missing");
  console.error("[pairing-qr] Set CLOUDFLARE_ACCESS_CLIENT_ID / CLOUDFLARE_ACCESS_CLIENT_SECRET, or store them in macOS Keychain services:");
  console.error("[pairing-qr]   bitty-cloudflare-access-client-id");
  console.error("[pairing-qr]   bitty-cloudflare-access-client-secret");
  process.exit(0);
}

const payload = {
  type: "bitty.runner.pairing",
  version: 1,
  runnerUrl,
  runnerWsUrl: buildRunnerWsUrl(runnerUrl),
  runnerToken,
  cloudflareAccessClientId,
  cloudflareAccessClientSecret,
  issuedAt: new Date().toISOString(),
};

console.error("[pairing-qr] Scan this QR from the Expo Cloudflare Tunnel screen.");
console.error(`[pairing-qr] runnerUrl=${runnerUrl}`);
console.error(`[pairing-qr] accessClientId=${cloudflareAccessClientId.slice(0, 8)}...`);
console.error("[pairing-qr] Treat the QR as a secret. Do not screenshot or share it.");
qrcode.generate(JSON.stringify(payload), { small: true });
