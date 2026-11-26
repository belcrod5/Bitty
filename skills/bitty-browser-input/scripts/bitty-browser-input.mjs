#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requestControl, resolveControlSocket } from "../../bitty-session-orchestrator/scripts/runner-control.mjs";

const usage = "bitty-browser-input.mjs request --context <ctx> --cdp-url <local page ws URL> --origin <origin> --selector <CSS> --label <label> [--frame-id <id>] | status --request <UUID>";
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
  const allowed = command === "request" ? ["--context", "--cdp-url", "--origin", "--selector", "--label", "--frame-id"] : ["--request"];
  if (!["request", "status"].includes(command) || Object.keys(options).some((key) => !allowed.includes(key))
    || (command === "request" ? allowed.slice(0, 5).some((key) => !options[key]) : !options["--request"])) throw new Error(usage);
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
    if (!response.ok) throw new Error("Browser input request unavailable");
    // Do not forward arbitrary server response fields to the model.
    if (result.requestId !== (body?.requestId || pathname.split("/").at(-1))
      || !["preparing", "pending", "filling", "completed", "cancelled", "expired", "failed", "input_status_unknown", "not_found"].includes(result.status)) throw new Error("Invalid browser input status");
    return { requestId: result.requestId, status: result.status };
  };
  if (command === "status") {
    if (!/^[a-f0-9-]{36}$/i.test(options["--request"])) throw new Error("Invalid request ID");
    console.log(JSON.stringify(await request(`/browser-input/requests/${options["--request"]}`)));
    return;
  }
  const id = randomUUID();
  console.log(JSON.stringify({ requestId: id, status: "requesting" }));
  let result = await request("/browser-input/requests", {
    requestId: id, context: options["--context"], target: {
      cdpUrl: options["--cdp-url"], origin: options["--origin"], selector: options["--selector"], label: options["--label"],
      ...(options["--frame-id"] ? { frameId: options["--frame-id"] } : {}),
    },
  });
  const deadline = Date.now() + 125_000;
  while (["preparing", "pending", "filling"].includes(result.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await request(`/browser-input/requests/${id}`);
  }
  console.log(JSON.stringify(result));
}
main().catch(() => { console.error("Browser input unavailable. Use --help for usage; recover an issued request with status --request UUID."); process.exitCode = 1; });
