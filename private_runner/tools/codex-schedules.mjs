import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestControl, resolveControlSocket } from "../../skills/bitty-session-orchestrator/scripts/runner-control.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_KEYS = ["RUNNER_TOKEN_FILE", "RUNNER_CONTROL_SOCKET"];
const RUNNER_ERROR_CODES = new Set([
  "invalid_codex_schedules",
  "orchestrator_not_found",
  "orchestrator_schedule_api_required",
  "invalid_codex_schedule_id",
  "idempotency_key_required",
  "invalid_idempotency_key",
  "unauthorized",
  "codex_schedule_not_found",
  "revision_conflict",
  "idempotency_conflict",
  "method_not_allowed",
  "runner_token_missing",
  "codex_schedule_store_unavailable",
]);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = path.join(REPOSITORY_ROOT, "private_runner/.env");

class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message) {
  throw new CliError(code, message);
}

function parseValue(raw, key) {
  let value;
  if (raw.startsWith("\"") || raw.startsWith("'")) {
    const quote = raw[0];
    let end = -1;
    for (let index = 1; index < raw.length; index += 1) {
      if (raw[index] === quote) {
        end = index;
        break;
      }
    }
    if (end < 0 || (raw.slice(end + 1).trim() && !/^\s+#.*$/.test(raw.slice(end + 1)))) {
      fail("runner_config_invalid", `${key} has an invalid quoted value`);
    }
    value = raw.slice(1, end);
    if (value.includes(quote)) fail("runner_config_invalid", `${key} has an invalid quoted value`);
  } else {
    const match = raw.match(/^(\S*)(?:\s+#.*)?$/);
    if (!match) fail("runner_config_invalid", `${key} must quote values containing spaces`);
    value = match[1];
  }
  if (/[\\$`~]/.test(value)) {
    fail("runner_config_invalid", `${key} contains unsupported shell syntax`);
  }
  return value;
}

function parseEnv(text, initial) {
  const values = { ...initial };
  const keyPattern = CONFIG_KEYS.join("|");
  const assignment = new RegExp(`^(?:export\\s+)?(${keyPattern})=(.*)$`);
  const related = new RegExp(`^(?:(?:export|unset)\\s+)?(?:${keyPattern})(?:\\b|[+?])`);
  const shellOperation = new RegExp(
    `^(?:export|readonly|declare|typeset|local|unset)\\b` +
      `(?:\\s+(?:--|[+-][A-Za-z]+))*\\s+(?:${keyPattern})(?:\\b|=)`,
  );
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(assignment);
    if (match) {
      values[match[1]] = parseValue(match[2], match[1]);
    } else if (related.test(trimmed) || shellOperation.test(trimmed)) {
      fail("runner_config_invalid", "Runner configuration contains an unsupported assignment");
    }
  }
  return values;
}

function validateEffectiveValue(value, key) {
  if (/[\\$`~]/.test(value)) {
    fail("runner_config_invalid", `${key} contains unsupported shell syntax`);
  }
}

async function loadRunnerConfig() {
  const initial = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key] || ""]));
  let values = initial;
  try {
    values = parseEnv(await fs.readFile(ENV_PATH, "utf8"), initial);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof CliError) throw error;
      fail("runner_config_invalid", "Runner configuration could not be read");
    }
  }
  for (const key of CONFIG_KEYS) validateEffectiveValue(values[key], key);
  const configuredTokenPath = values.RUNNER_TOKEN_FILE || "private_runner/logs/runner-token";
  const tokenPath = path.isAbsolute(configuredTokenPath)
    ? configuredTokenPath
    : path.resolve(REPOSITORY_ROOT, configuredTokenPath);
  let socketPath;
  try { socketPath = await resolveControlSocket(REPOSITORY_ROOT, values.RUNNER_CONTROL_SOCKET); }
  catch { fail("runner_config_invalid", "Runner control socket configuration is unavailable or invalid"); }
  return { socketPath, tokenPath };
}

async function readToken(tokenPath) {
  let stat;
  let token;
  try {
    stat = await fs.lstat(tokenPath);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      fail("runner_token_file_invalid", `Runner token file must be a regular file with mode 600: ${tokenPath}`);
    }
    token = (await fs.readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("runner_token_file_invalid", `Runner token file is not readable: ${tokenPath}`);
  }
  if (!token) fail("runner_token_file_invalid", `Runner token file is empty: ${tokenPath}`);
  return token;
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function parseInput(filePath) {
  let text;
  if (filePath) {
    const piped = process.stdin.isTTY ? "" : await readStdin();
    if (piped.trim()) fail("invalid_cli_usage", "Use either stdin or --file, not both");
    try {
      text = await fs.readFile(path.resolve(filePath), "utf8");
    } catch {
      fail("invalid_input", "Input file could not be read");
    }
  } else {
    text = await readStdin();
  }
  if (!text.trim()) fail("invalid_input", "A JSON request is required");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail("invalid_input", "Input must be a JSON object");
  }
}

function parseArguments(argv) {
  const command = argv[0];
  if (!command || !["list", "create", "update", "delete", "orchestrator-get", "orchestrator-set"].includes(command)) {
    fail("invalid_cli_usage", "Use list, create, update, delete, orchestrator-get, or orchestrator-set; --help shows input formats");
  }
  let filePath = null;
  const positional = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--file") {
      if (filePath !== null || !argv[index + 1]) fail("invalid_cli_usage", "--file requires one path");
      filePath = argv[index + 1];
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  if (command === "list") {
    if (filePath || positional.length) fail("invalid_cli_usage", "list does not accept input or an ID");
  } else if (command === "create") {
    if (positional.length) fail("invalid_cli_usage", "create does not accept a schedule ID");
  } else if (command.startsWith("orchestrator-")) {
    if (positional.length !== 1 || (positional[0] !== "main" && !UUID_PATTERN.test(positional[0]))) {
      fail("invalid_cli_usage", `${command} requires main or one orchestrator UUID`);
    }
    if (command === "orchestrator-get" && filePath) fail("invalid_cli_usage", "orchestrator-get does not accept input");
  } else if (positional.length !== 1 || !UUID_PATTERN.test(positional[0])) {
    fail("invalid_cli_usage", `${command} requires one UUID schedule ID`);
  }
  return { command, filePath, id: positional[0] || null };
}

async function requestRunner({ command, id, input, requestId }) {
  const { socketPath, tokenPath } = await loadRunnerConfig();
  const token = await readToken(tokenPath);
  const memberPath = id ? `/${encodeURIComponent(id)}` : "";
  const owner = command.startsWith("orchestrator-");
  const endpoint = owner ? `/orchestrators/${encodeURIComponent(id)}/schedule` : `/codex-schedules${memberPath}`;
  const method = { list: "GET", create: "POST", update: "PATCH", delete: "DELETE", "orchestrator-get": "GET", "orchestrator-set": "PUT" }[command];
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(input);
  }
  if (requestId) headers["Idempotency-Key"] = requestId;
  let response;
  try {
    response = await requestControl(socketPath, endpoint, {
      method,
      headers,
      body,
      timeout: 10_000,
    });
  } catch (error) {
    if (error?.message === "Runner control request timed out") fail("runner_request_timeout", "Runner request timed out");
    if (error?.code === "runner_response_incomplete") fail("invalid_runner_response", "Runner response could not be read");
    fail("runner_connection_failed", "Could not connect to the local Runner");
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    fail("invalid_runner_response", "Runner returned invalid JSON");
  }
  if (!response.ok) {
    if (!RUNNER_ERROR_CODES.has(payload.error)) {
      fail("invalid_runner_response", "Runner returned an unknown error response");
    }
    const safePayload = { error: payload.error };
    if (["revision_conflict", "idempotency_conflict"].includes(payload.error) &&
      Number.isInteger(payload.revision) && payload.revision >= 0) {
      safePayload.revision = payload.revision;
    }
    if (payload.error === "idempotency_conflict" &&
      typeof payload.id === "string" && UUID_PATTERN.test(payload.id)) {
      safePayload.id = payload.id;
    }
    if (typeof payload.message === "string" && payload.message.length > 0 &&
      payload.message.length <= 1_000) {
      const inputStrings = [];
      const pending = [input];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === "string") inputStrings.push(value);
        else if (Array.isArray(value)) pending.push(...value);
        else if (value && typeof value === "object") pending.push(...Object.values(value));
      }
      const containsSensitiveValue = payload.message.includes(token) ||
        (body && payload.message.includes(body)) ||
        inputStrings.some((value) => value && payload.message.includes(value));
      if (!containsSensitiveValue) safePayload.message = payload.message;
    }
    if (payload.error === "orchestrator_schedule_api_required") {
      safePayload.message = "Use orchestrator-get <orchestratorId> then orchestrator-set <orchestratorId> --file <JSON>; --help shows the settings schema.";
    }
    if (requestId) safePayload.requestId = requestId;
    process.stderr.write(`${JSON.stringify(safePayload)}\n`);
    process.exitCode = 2;
    return;
  }
  if (payload.ok !== true) fail("invalid_runner_response", "Runner success response is invalid");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  let requestId = null;
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write(`Usage: node private_runner/tools/codex-schedules.mjs list|create|update <id>|delete <id> [--file <JSON>]
Orchestrator: orchestrator-get <main|owner UUID> / orchestrator-set <main|owner UUID> --file <JSON>
Read orchestrator-get first; retain its revision as baseRevision. Set JSON:
{"baseRevision":0,"settings":{"enabled":true,"trigger":{"kind":"interval","minutes":60},"prompt":"Suggest a useful next step","systemInstruction":""}}
For every day at 09:00 Japan time replace trigger with:
{"kind":"calendar","startLocal":"2026-11-16T09:00:00","timeZone":"Asia/Tokyo","rrule":"FREQ=DAILY"}
Calendar rrule: null (once), FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY, FREQ=YEARLY.
Interval: 1..10080 minutes. Never mix interval and calendar fields. Preserve trigger when toggling enabled.
One setting per orchestrator. Existing generic voice updates preserve the schedule ID and share owner validation; create only when the owner has no setting. To disable, update enabled; generic delete removes the saved setting.
After saving, orchestrator-get again and report the returned trigger and nextOccurrenceAt.
Use a mode-600 JSON file. On revision_conflict reload and preserve concurrent edits.
`);
      return;
    }
    const args = parseArguments(process.argv.slice(2));
    if (args.command === "list" || args.command === "orchestrator-get") {
      if (!process.stdin.isTTY && (await readStdin()).trim()) {
        fail("invalid_cli_usage", "list does not accept stdin");
      }
      await requestRunner(args);
      return;
    }
    const input = await parseInput(args.filePath);
    if (args.command === "create") {
      if (input.requestId === undefined) {
        requestId = randomUUID();
      } else if (typeof input.requestId === "string" && UUID_PATTERN.test(input.requestId)) {
        requestId = input.requestId;
      } else {
        fail("invalid_input", "requestId must be a UUID");
      }
      if (!UUID_PATTERN.test(requestId)) fail("invalid_input", "Could not create a valid requestId");
      const { requestId: _requestId, ...body } = input;
      await requestRunner({ ...args, input: body, requestId });
      return;
    }
    await requestRunner({ ...args, input, requestId });
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError("runner_connection_failed", "The local Runner request failed");
    const payload = { error: failure.code, message: failure.message };
    if (requestId) payload.requestId = requestId;
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = failure.exitCode;
  }
}

await main();
