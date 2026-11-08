import { spawnSync } from "node:child_process";
import qrcode from "qrcode-terminal";

import { loadLocalRunnerTls, resolveLocalRunnerTlsConfig } from "./local-runner-tls.mjs";

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

const runnerUrl = normalizeHttpUrl(
  process.env.RUNNER_PUBLIC_URL || process.env.CLOUDFLARE_RUNNER_PUBLIC_URL
);
const cloudflareAccessClientId = readEnvOrKeychain(
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  process.env.CLOUDFLARE_ACCESS_CLIENT_ID_KEYCHAIN_SERVICE || "bitty-cloudflare-access-client-id"
);
const cloudflareAccessClientSecret = readEnvOrKeychain(
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET_KEYCHAIN_SERVICE || "bitty-cloudflare-access-client-secret"
);

if (!runnerUrl) {
  console.error("✕ 接続先が未設定です。RUNNER_PUBLIC_URLにHTTPSのURLを設定してください。");
  process.exit(1);
}
if (!cloudflareAccessClientId || !cloudflareAccessClientSecret) {
  console.error("✕ Cloudflare Accessの接続設定がありません。");
  console.error("private_runner/.envのCLOUDFLARE_ACCESS_CLIENT_IDとCLOUDFLARE_ACCESS_CLIENT_SECRETを確認してください。");
  process.exit(1);
}

let localTlsConfig;
let localRunnerCertificate = "";
try {
  localTlsConfig = resolveLocalRunnerTlsConfig();
  if (localTlsConfig) ({ localRunnerCertificate } = loadLocalRunnerTls(localTlsConfig));
} catch (error) {
  console.error(`✕ LAN接続の設定を読み取れません: ${error.message}`);
  process.exit(1);
}
const localRunnerUrl = localTlsConfig?.url || "";

const payload = {
  type: "bitty.runner.pairing",
  version: 2,
  schemaVersion: 2,
  runnerUrl,
  localRunnerUrl,
  localRunnerCertificate,
  cloudflareAccessClientId,
  cloudflareAccessClientSecret,
  issuedAt: new Date().toISOString(),
};

console.error("\n▣ Bittyアプリ用の接続QR");
console.error("アプリの「接続先を設定」→「接続QRを読み取る」で読み取ってください。");
console.error("認証アプリ用ではありません。QRは共有しないでください。");
qrcode.generate(JSON.stringify(payload), { small: true });
console.error("✓ 接続先を設定したら、アプリでログインしてください。");
