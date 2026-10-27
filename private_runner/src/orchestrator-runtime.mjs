import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerClient } from "./codex-app-server-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => Object.assign(new Error("The isolated orchestrator runtime is unavailable"), { code: "orchestrator_runtime_unavailable" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each specialist owns its Codex configuration, sessions, native agents and skill discovery.
// Authentication stays in the Runner and is injected into process memory, never copied to disk.
export function createOrchestratorRuntime({ rootDir, resolveAuth, codexBin = "codex", spawnImpl = spawn,
  createClient = createCodexAppServerClient, childEnv = process.env } = {}) {
  const root = path.resolve(rootDir);
  const processes = new Map();
  let stopped = false;

  async function directory(target) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw unavailable();
    return fs.realpath(target);
  }

  async function markWorkspace(workspace) {
    const marker = path.join(workspace, ".bitty-orchestrator-root");
    await fs.writeFile(marker, "", { flag: "wx", mode: 0o600 })
      .catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
  }

  async function initialize(client) {
    await client.openPromise;
    const initialized = await client.request("initialize", {
      clientInfo: { name: "bitty-orchestrator-runtime", version: "0.1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    }, 10_000);
    client.notify("initialized", {});
    return initialized;
  }

  async function stop(record) {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      await record.launched;
      for (const client of record.clients) client.close();
      record.clients.clear();
      if (record.child && record.child.exitCode === null) {
        record.child.kill("SIGTERM");
        await Promise.race([record.exit, delay(3_500)]);
        if (record.child.exitCode === null) record.child.kill("SIGKILL");
        await Promise.race([record.exit, delay(1_000)]);
      }
      if (record.socketDirectory) await fs.rm(record.socketDirectory, { recursive: true, force: true });
    })();
    return record.stopping;
  }

  async function start(id, workspace) {
    const record = { workspace, clients: new Set(), child: null, authDigest: "", serial: Promise.resolve(), stopping: null };
    let launched;
    record.launched = new Promise((resolve) => { launched = resolve; });
    processes.set(id, record);
    record.ready = (async () => {
      const runtimeRoot = await directory(path.join(path.dirname(workspace), "runtime-home"));
      const home = await directory(path.join(runtimeRoot, "home"));
      record.codexHome = await directory(path.join(runtimeRoot, "codex"));
      const xdg = await directory(path.join(runtimeRoot, "config"));
      const temporary = await directory(path.join(runtimeRoot, "tmp"));
      await markWorkspace(workspace);
      // Short disposable socket path avoids macOS's Unix socket pathname limit.
      record.socketDirectory = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "bitty-orchestrator-"));
      const socket = path.join(record.socketDirectory, "rpc.sock");
      record.upstreamUrl = `ws+unix://${socket}:/`;
      const env = { PATH: childEnv.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home,
        CODEX_HOME: record.codexHome, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: xdg,
        CODEX_SQLITE_HOME: record.codexHome, TMPDIR: temporary };
      if (record.stopping || stopped) throw unavailable();
      record.child = spawnImpl(process.execPath, [fileURLToPath(new URL("./orchestrator-runtime-process.mjs", import.meta.url)), codexBin, "app-server", "--strict-config", "--listen", `unix://${socket}`,
        "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "analytics.enabled=false",
        "-c", 'project_root_markers=[".bitty-orchestrator-root"]'],
      { cwd: workspace, env, stdio: ["ignore", "ignore", "pipe", "ipc"], shell: false });
      launched();
      record.child.stderr?.resume();
      record.exit = new Promise((resolve) => {
        const exited = () => {
          if (processes.get(id) === record) processes.delete(id);
          for (const client of record.clients) client.close();
          record.clients.clear();
          resolve();
          void stop(record).catch(() => {});
        };
        record.child.once("exit", exited);
        record.child.once("error", exited);
      });
      record.child.once("disconnect", () => {
        if (processes.get(id) === record) processes.delete(id);
        void stop(record).catch(() => {});
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (record.stopping || stopped || record.child.exitCode !== null) throw unavailable();
        const probe = createClient({ upstreamUrl: record.upstreamUrl, upstreamToken: "" });
        record.clients.add(probe);
        try {
          const initialized = await initialize(probe);
          if (initialized?.codexHome !== record.codexHome) throw unavailable();
          return;
        } catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw unavailable();
        } finally { probe.close(); record.clients.delete(probe); }
        await delay(50);
      }
      throw unavailable();
    })().catch(async () => {
      launched();
      if (processes.get(id) === record) processes.delete(id);
      await stop(record);
      throw unavailable();
    });
    return record;
  }

  return {
    async createClient({ orchestratorId: id, workspaceDirectory, ...options }) {
      if (stopped || id !== "main" && !UUID.test(id)) throw unavailable();
      if (options.signal?.aborted) throw Object.assign(new Error("Orchestrator request aborted"), { code: "ABORT_ERR" });
      const expected = path.join(root, ...(id === "main" ? [] : ["orchestrators", id]), "workspace");
      if ((await fs.lstat(expected)).isSymbolicLink()) throw unavailable();
      const workspace = await fs.realpath(expected);
      if (await fs.realpath(workspaceDirectory) !== workspace) throw unavailable();
      await markWorkspace(workspace);
      let record = processes.get(id);
      if (record && record.workspace !== workspace) throw unavailable();
      record ||= await start(id, workspace);
      await record.ready;
      const authenticated = record.serial.then(async () => {
        if (record.stopping || stopped) throw unavailable();
        const auth = await resolveAuth();
        if (record.stopping || stopped || processes.get(id) !== record) throw unavailable();
        if (!auth?.accessToken || !auth.accountId) throw unavailable();
        const digest = createHash("sha256").update(auth.accountId).update("\0").update(auth.accessToken).digest("hex");
        if (record.authDigest === digest) return;
        const management = createClient({ upstreamUrl: record.upstreamUrl, upstreamToken: "" });
        record.clients.add(management);
        try {
          await initialize(management);
          const result = await management.request("account/login/start", {
            type: "chatgptAuthTokens", accessToken: auth.accessToken, chatgptAccountId: auth.accountId,
          }, 10_000);
          if (result?.type !== "chatgptAuthTokens") throw unavailable();
          const account = await management.request("account/read", {}, 10_000);
          const accountId = account?.account?.accountId || account?.account?.id || account?.accountId || account?.id;
          if (accountId && accountId !== auth.accountId) throw unavailable();
          record.authDigest = digest;
        } finally { management.close(); record.clients.delete(management); }
      });
      record.serial = authenticated.catch(() => {});
      await authenticated;
      if (record.stopping || stopped || processes.get(id) !== record) throw unavailable();
      const originalClose = options.onClose;
      let client;
      client = createClient({ ...options, upstreamUrl: record.upstreamUrl, upstreamToken: "",
        authRefreshHandler: async (request) => {
          if (request?.params?.reason !== "unauthorized") throw unavailable();
          const current = await resolveAuth();
          if (current.accountId !== request.params.previousAccountId) throw unavailable();
          const refreshed = await resolveAuth({ forceRefresh: true });
          if (refreshed.accountId !== request.params.previousAccountId) throw unavailable();
          record.authDigest = "";
          return { accessToken: refreshed.accessToken, chatgptAccountId: refreshed.accountId };
        },
        onClose: () => { record.clients.delete(client); originalClose?.(); },
      });
      if (!options.signal?.aborted) record.clients.add(client);
      return client;
    },
    async dispose(id) {
      const record = processes.get(id);
      if (!record) return;
      processes.delete(id);
      await stop(record);
    },
    async shutdown() {
      stopped = true;
      const records = [...processes.values()];
      processes.clear();
      await Promise.all(records.map(stop));
    },
  };
}
