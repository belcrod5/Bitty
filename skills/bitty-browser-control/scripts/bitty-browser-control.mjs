#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { requestControl, resolveControlSocket } from "../../bitty-session-orchestrator/scripts/runner-control.mjs";

const usage = "bitty-browser-control.mjs request|replace --context <ctx> (--cdp-url <local ws URL> | --user-data-dir <absolute Chrome data directory>) [--target-id <page ID>] --origin <origin> --label <label> | discover --user-data-dir <absolute Chrome data directory> --origin <origin> | cancel --context <ctx> --request <UUID> | status --request <UUID>";
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
  const allowed = ["request", "replace"].includes(command) ? ["--context", "--cdp-url", "--user-data-dir", "--target-id", "--origin", "--label"]
    : command === "discover" ? ["--user-data-dir", "--origin"] : command === "cancel" ? ["--context", "--request"] : ["--request"];
  const required = ["request", "replace"].includes(command) ? ["--context", "--origin", "--label"] : allowed;
  if (!["request", "replace", "discover", "cancel", "status"].includes(command) || Object.keys(options).some((key) => !allowed.includes(key))
    || required.some((key) => !options[key])) throw new Error(usage);
  if (options["--request"] && !/^[a-f0-9-]{36}$/i.test(options["--request"])) throw new Error("Invalid request ID");
  const repo = await root();
  if (["request", "replace"].includes(command) && (!!options["--cdp-url"] === !!options["--user-data-dir"] || options["--user-data-dir"] && !options["--target-id"])) throw new Error(usage);
  if (command === "discover" || options["--user-data-dir"]) {
    const { readBrowserControlEndpoint, discoverBrowserControlTargets } = await import(pathToFileURL(path.join(repo, "private_runner/src/browser-control-discovery.mjs")));
    const cdpUrl = await readBrowserControlEndpoint(options["--user-data-dir"]);
    if (command === "discover") {
      console.log(JSON.stringify(await discoverBrowserControlTargets(cdpUrl, options["--origin"]))); return;
    }
    options["--cdp-url"] = cdpUrl;
  }
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
    if (!response.ok) throw new Error("Browser control request unavailable");
    // Do not forward arbitrary server response fields to the model.
    if (result.requestId !== (body?.requestId || pathname.split("/").at(-1))
      || !["preparing", "pending", "starting", "active", "completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown", "not_found"].includes(result.status)) throw new Error("Invalid browser input status");
    return { requestId: result.requestId, status: result.status, ...(result.inputStatusUnknown === true ? { inputStatusUnknown: true } : {}) };
  };
  if (command === "status" || command === "cancel") {
    console.log(JSON.stringify(await request(`/browser-control/requests/${options["--request"]}${command === "cancel" ? "/cancel" : ""}`,
      command === "cancel" ? { requestId: options["--request"], context: options["--context"] } : undefined)));
    return;
  }
  const id = randomUUID();
  console.log(JSON.stringify({ requestId: id, status: "requesting" }));
  const result = await request("/browser-control/requests", {
    requestId: id, context: options["--context"], ...(command === "replace" ? { replace: true } : {}), target: {
      cdpUrl: options["--cdp-url"], ...(options["--target-id"] ? { targetId: options["--target-id"] } : {}), origin: options["--origin"], label: options["--label"],
    },
  });
  console.log(JSON.stringify(result));
}
main().catch((error) => {
  const hints = { chrome_debugging_not_enabled: "Open Chrome chrome://inspect/#remote-debugging and enable debugging; check the user data directory.", chrome_debugging_endpoint_invalid: "Chrome debugging endpoint is invalid; reopen Chrome debugging settings.", chrome_permission_timeout: "Chrome permission timed out; allow the connection on the Mac, then retry.", chrome_discovery_unavailable: "Chrome connection failed or permission was denied; check Chrome on the Mac and retry." };
  if (Object.hasOwn(hints, error?.code)) { console.error(`${error.code}: ${hints[error.code]}`); process.exitCode = 1; return; }
  console.error("Browser control unavailable. Use --help for usage; recover an issued request with status --request UUID."); process.exitCode = 1; });
