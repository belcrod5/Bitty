#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requestControl, resolveControlSocket } from "../../bitty-session-orchestrator/scripts/runner-control.mjs";

const usage = "bitty-browser-control.mjs discover --origin <origin> | request|replace --context <ctx> (--browser-id <UUID> --target-id <CDP page ID> | --cdp-url <local page ws URL>) --origin <origin> --label <label> | cancel --context <ctx> --request <UUID> | status --request <UUID>";
async function root() {
  if (process.env.BITTY_REPO_ROOT) return path.resolve(process.env.BITTY_REPO_ROOT);
  for (let directory = process.cwd();; directory = path.dirname(directory)) {
    if (await fs.stat(path.join(directory, "private_runner/src/server-runtime.mjs")).then((s) => s.isFile(), () => false)) return directory;
    if (path.dirname(directory) === directory) throw new Error("Set BITTY_REPO_ROOT to the running Runner repository");
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help") { console.log(usage); return; }
  const options = {};
  while (args.length) {
    const key = args.shift(); const value = args.shift();
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = value;
  }
  const allowed = ["request", "replace"].includes(command) ? ["--context", "--cdp-url", "--browser-id", "--target-id", "--origin", "--label"]
    : command === "discover" ? ["--origin"] : command === "cancel" ? ["--context", "--request"] : ["--request"];
  const required = ["request", "replace"].includes(command) ? ["--context", "--origin", "--label"] : allowed;
  if (!["request", "replace", "discover", "cancel", "status"].includes(command) || Object.keys(options).some((key) => !allowed.includes(key))
    || required.some((key) => !options[key])) throw new Error(usage);
  if (["request", "replace"].includes(command) && (!!options["--cdp-url"] === !!options["--browser-id"] || !!options["--browser-id"] !== !!options["--target-id"])) throw new Error(usage);
  if (options["--request"] && !/^[a-f0-9-]{36}$/i.test(options["--request"])) throw new Error("Invalid request ID");
  const repo = await root();
  const tokenPath = path.resolve(repo, process.env.BITTY_RUNNER_TOKEN_FILE || process.env.RUNNER_TOKEN_FILE || "private_runner/logs/runner-token");
  const stat = await fs.lstat(tokenPath);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Runner token must be an owner-only regular file");
  const token = (await fs.readFile(tokenPath, "utf8")).trim();
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("Invalid Runner token");
  const socketPath = await resolveControlSocket(repo);
  const request = async (pathname, body) => {
    const response = await requestControl(socketPath, pathname, {
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), timeout: 10_000,
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error("Browser control request unavailable"), { code: ["browser_extension_not_connected", "browser_extension_ambiguous", "browser_extension_connection_changed", "browser_extension_timeout"].includes(result.status) ? result.status : "unavailable" });
    if (command === "discover") {
      if (typeof result.browserId !== "string" || !/^[a-f0-9-]{36}$/i.test(result.browserId) || !Array.isArray(result.targets) || result.targets.length > 100) throw new Error();
      return { browserId: result.browserId, targets: result.targets.map((entry) => {
        if (typeof entry?.targetId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.targetId) || !Number.isSafeInteger(entry.tabId) || entry.tabId < 1 || entry.origin !== options["--origin"]) throw new Error();
        return { targetId: entry.targetId, tabId: entry.tabId, origin: entry.origin };
      }) };
    }
    // Do not forward arbitrary server response fields to the model.
    if (result.requestId !== (body?.requestId || pathname.split("/").at(-1))
      || !["preparing", "pending", "starting", "active", "completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown", "not_found"].includes(result.status)) throw new Error("Invalid browser input status");
    return { requestId: result.requestId, status: result.status, ...(result.inputStatusUnknown === true ? { inputStatusUnknown: true } : {}) };
  };
  if (command === "discover") { console.log(JSON.stringify(await request(`/browser-control/targets?origin=${encodeURIComponent(options["--origin"])}`))); return; }
  if (command === "status" || command === "cancel") {
    console.log(JSON.stringify(await request(`/browser-control/requests/${options["--request"]}${command === "cancel" ? "/cancel" : ""}`,
      command === "cancel" ? { requestId: options["--request"], context: options["--context"] } : undefined)));
    return;
  }
  const id = randomUUID();
  console.log(JSON.stringify({ requestId: id, status: "requesting" }));
  const result = await request("/browser-control/requests", {
    requestId: id, context: options["--context"], ...(command === "replace" ? { replace: true } : {}), target: {
      ...(options["--browser-id"] ? { browserId: options["--browser-id"], targetId: options["--target-id"] } : { cdpUrl: options["--cdp-url"] }), origin: options["--origin"], label: options["--label"],
    },
  });
  console.log(JSON.stringify(result));
}
main().catch((error) => {
  const hints = { browser_extension_not_connected: "Install the Bitty extension in the intended Chrome profile and keep Chrome running.", browser_extension_ambiguous: "Several Chrome profiles are connected; leave the Bitty extension enabled only in the intended profile.", browser_extension_connection_changed: "Chrome reconnected; discover the same intended tab again before creating a replacement panel.", browser_extension_timeout: "The Bitty extension did not reply; check Chrome and its Native Messaging installation." };
  console.error(Object.hasOwn(hints, error?.code) ? `${error.code}: ${hints[error.code]}` : "Browser control unavailable. Use --help for usage; recover an issued request with status --request UUID."); process.exitCode = 1;
});
