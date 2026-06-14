#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadEnvFile(filePath) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) continue;

    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    value = value
      .replace(/\$\{HOME\}/g, process.env.HOME || "")
      .replace(/\$HOME/g, process.env.HOME || "");
    process.env[key] = value;
  }
}

await loadEnvFile(path.join(__dirname, ".env"));

const rawCodexHome = process.env.CODEX_HOME || path.join(__dirname, ".codex-home");
const CODEX_HOME = path.isAbsolute(rawCodexHome)
  ? rawCodexHome
  : path.resolve(process.cwd(), rawCodexHome);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_AUTH_STORE = process.env.CODEX_AUTH_STORE || "file";
const args = process.argv.slice(2);

const useDeviceAuth = args.includes("--device-auth");

function run(cmd, commandArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, commandArgs, {
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${commandArgs.join(" ")} exited with code ${code}`));
    });
  });
}

async function upsertCodexAuthStore(configPath, storeValue) {
  const setting = `cli_auth_credentials_store = "${storeValue}"`;
  let current = "";

  try {
    current = await fs.readFile(configPath, "utf8");
  } catch {
    current = "";
  }

  if (/^\s*cli_auth_credentials_store\s*=.*$/m.test(current)) {
    const next = current.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, setting);
    await fs.writeFile(configPath, next, "utf8");
    return;
  }

  const prefix = current.trimEnd();
  const next = prefix ? `${prefix}\n${setting}\n` : `${setting}\n`;
  await fs.writeFile(configPath, next, "utf8");
}

async function main() {
  await fs.mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });

  const configPath = path.join(CODEX_HOME, "config.toml");
  await upsertCodexAuthStore(configPath, CODEX_AUTH_STORE);

  const env = {
    ...process.env,
    CODEX_HOME,
  };

  const loginArgs = [
    "login",
    "-c",
    `cli_auth_credentials_store="${CODEX_AUTH_STORE}"`,
  ];
  if (useDeviceAuth) loginArgs.push("--device-auth");

  console.log(`[setup] CODEX_HOME=${CODEX_HOME}`);
  console.log(`[setup] using ${CODEX_BIN} login (${CODEX_AUTH_STORE} store)`);
  await run(CODEX_BIN, loginArgs, env);

  const statusArgs = [
    "login",
    "status",
    "-c",
    `cli_auth_credentials_store="${CODEX_AUTH_STORE}"`,
  ];
  await run(CODEX_BIN, statusArgs, env);

  const authPath = path.join(CODEX_HOME, "auth.json");
  try {
    await fs.access(authPath);
    console.log(`[setup] auth cache ready: ${authPath}`);
  } catch {
    console.log(`[setup] login completed but auth.json was not found at ${authPath}`);
  }
}

main().catch((err) => {
  console.error(`[setup] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
