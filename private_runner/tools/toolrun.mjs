#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_MANIFEST_PATH = path.resolve(WORKSPACE_ROOT, "private_runner/toolbox/manifest.json");
const MANIFEST_PATH = path.resolve(
  WORKSPACE_ROOT,
  process.env.TOOLRUN_MANIFEST_PATH || "private_runner/toolbox/manifest.json"
);
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ARGS = 8;
const MAX_ARG_LENGTH = 400;
const MAX_OUTPUT_BYTES = 65536;

function fail(message, code = 1) {
  process.stderr.write(`${String(message || "toolrun failed").trim()}\n`);
  process.exit(code);
}

function clamp(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  const n = Number(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function looksLikeToolName(raw) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(raw || "").trim());
}

function normalizeManifest(raw) {
  const tools = {};
  const root = raw && typeof raw === "object" ? raw : {};
  const rawTools = root.tools && typeof root.tools === "object" ? root.tools : {};
  for (const [nameRaw, defRaw] of Object.entries(rawTools)) {
    const toolName = String(nameRaw || "").trim();
    if (!looksLikeToolName(toolName)) continue;
    if (!defRaw || typeof defRaw !== "object") continue;
    const command = String(defRaw.command || "").trim();
    if (!command) continue;
    const timeoutMs = clamp(Number(defRaw.timeoutMs || DEFAULT_TIMEOUT_MS), 1000, MAX_TIMEOUT_MS);
    const allowExtraArgs = Boolean(defRaw.allowExtraArgs);
    const argSpec = Array.isArray(defRaw.argSpec) ? defRaw.argSpec : [];
    tools[toolName] = {
      command,
      timeoutMs,
      allowExtraArgs,
      argSpec: argSpec.map((spec) => ({
        name: String(spec?.name || "").trim(),
        required: Boolean(spec?.required),
        minLength: Number.isFinite(Number(spec?.minLength)) ? Number(spec.minLength) : undefined,
        maxLength: Number.isFinite(Number(spec?.maxLength)) ? Number(spec.maxLength) : undefined,
        pattern: String(spec?.pattern || "").trim() || undefined,
      })),
    };
  }
  return { tools };
}

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeManifest(parsed);
}

function validateArgs(toolName, toolDef, args) {
  if (!Array.isArray(args)) fail("invalid args");
  if (args.length > MAX_ARGS) fail(`too many args (max ${MAX_ARGS})`);
  for (const arg of args) {
    if (typeof arg !== "string") fail("args must be strings");
    if (arg.includes("\u0000")) fail("args must not include NUL");
    if (arg.length > MAX_ARG_LENGTH) fail(`arg is too long (max ${MAX_ARG_LENGTH})`);
  }

  const specs = Array.isArray(toolDef.argSpec) ? toolDef.argSpec : [];
  if (!toolDef.allowExtraArgs && args.length > specs.length) {
    fail(`too many args for ${toolName}`);
  }

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i] || {};
    const value = args[i];
    const hasValue = value !== undefined;
    if (spec.required && !hasValue) {
      fail(`missing arg: ${spec.name || `arg${i + 1}`}`);
    }
    if (!hasValue) continue;
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      fail(`arg too short: ${spec.name || `arg${i + 1}`}`);
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      fail(`arg too long: ${spec.name || `arg${i + 1}`}`);
    }
    if (spec.pattern) {
      let re = null;
      try {
        re = new RegExp(spec.pattern);
      } catch {
        fail(`invalid pattern in manifest for ${toolName}`);
      }
      if (!re.test(value)) {
        fail(`invalid arg format: ${spec.name || `arg${i + 1}`}`);
      }
    }
  }
}

function resolveToolCommand(rawCommand) {
  const commandInput = String(rawCommand || "").trim();
  if (!commandInput) fail("command is missing in manifest");
  const commandAbs = path.isAbsolute(commandInput)
    ? path.resolve(commandInput)
    : path.resolve(WORKSPACE_ROOT, commandInput);
  const workspace = path.resolve(WORKSPACE_ROOT);
  if (commandAbs !== workspace && !commandAbs.startsWith(`${workspace}${path.sep}`)) {
    fail("tool command must be inside workspace");
  }
  return commandAbs;
}

async function runCommand(commandAbs, args, timeoutMs) {
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`toolrun timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const child = spawn(commandAbs, args, {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) return;
      const text = String(chunk);
      stdout += text.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length));
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_OUTPUT_BYTES) return;
      const text = String(chunk);
      stderr += text.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stderr.length));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(Number.isFinite(Number(code)) ? Number(code) : -1);
    });
  }).catch((err) => {
    if (timedOut) throw err;
    throw err;
  });

  if (timedOut) fail(`toolrun timed out after ${timeoutMs}ms`);
  if (exitCode !== 0) {
    const detail = (stderr || stdout || "").trim();
    fail(detail ? detail : `tool exited with code ${exitCode}`);
  }
  process.stdout.write(stdout.trim());
}

async function main() {
  const argv = process.argv.slice(2);
  const toolName = String(argv[0] || "").trim();
  const toolArgs = argv.slice(1).map((item) => String(item ?? ""));
  if (!looksLikeToolName(toolName)) {
    fail("invalid tool name");
  }

  const manifest = await loadManifest().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    fail(`failed to load manifest (${MANIFEST_PATH}): ${message}`);
  });
  const toolDef = manifest.tools[toolName];
  if (!toolDef) {
    fail(`unknown tool: ${toolName}`);
  }

  validateArgs(toolName, toolDef, toolArgs);
  const commandAbs = resolveToolCommand(toolDef.command);
  await fs.access(commandAbs).catch(() => {
    fail(`tool command is not accessible: ${toolDef.command}`);
  });
  await runCommand(commandAbs, toolArgs, toolDef.timeoutMs || DEFAULT_TIMEOUT_MS);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
