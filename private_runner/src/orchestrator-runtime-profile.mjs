import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const unavailable = () => Object.assign(new Error("This Codex runtime cannot isolate orchestrator knowledge and tools"), {
  code: "capability_unsupported", voiceReason: "orchestrator_isolation_unavailable",
});
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const within = (file, directory) => file === directory || file.startsWith(`${directory}${path.sep}`);

// This profile belongs to one thread configuration, never the shared Codex home.
export async function prepareOrchestratorRuntime(client, { workspaceDirectory, cwd, readOnly = false }) {
  try {
    const workspace = await fs.realpath(workspaceDirectory);
    const workingDirectory = await fs.realpath(cwd);
    if (!within(workingDirectory, workspace)) throw unavailable();
    const configured = await client.request("config/read", { cwd: workingDirectory }, 30_000);
    const config = configured?.config;
    if (!record(config) || config.mcp_servers !== undefined && !record(config.mcp_servers)) throw unavailable();
    const discovered = await client.request("skills/list", { cwds: [workingDirectory], forceReload: true }, 30_000);
    if (!Array.isArray(discovered?.data) || discovered.data.length !== 1) throw unavailable();
    const entry = discovered.data[0];
    if (!record(entry) || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length
      || typeof entry.cwd !== "string" || await fs.realpath(entry.cwd) !== workingDirectory) throw unavailable();
    const skills = [];
    for (const skill of entry.skills) {
      if (!record(skill) || typeof skill.path !== "string" || !path.isAbsolute(skill.path)) throw unavailable();
      // Missing files are disabled as well; they may have disappeared since discovery.
      const canonical = await fs.realpath(skill.path).catch(() => null);
      if (!canonical || !within(canonical, workspace)) skills.push({ path: skill.path, enabled: false });
    }
    const permissions = `bitty_orchestrator_${randomUUID().replaceAll("-", "")}`;
    const profile = { filesystem: { ":minimal": "read", ":workspace_roots": readOnly ? "read" : "write" },
      network: { enabled: false } };
    return { permissions, runtimeWorkspaceRoots: [workspace], config: {
      permissions: { [permissions]: profile },
      project_doc_max_bytes: 0,
      skills: { config: skills },
      features: { memories: false, hooks: false, apps: false, plugins: false, remote_plugin: false,
        computer_use: false, browser_use: false, browser_use_external: false, skill_search: false,
        skill_mcp_dependency_install: false, external_agent_memory_import: false },
      memories: { generate_memories: false, use_memories: false },
      apps: { _default: { enabled: false } },
      mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers || {}).map((name) => [name, { enabled: false }])),
      web_search: "disabled",
      shell_environment_policy: { inherit: "none" },
    } };
  } catch {
    throw unavailable();
  }
}

export function assertOrchestratorRuntime(started, runtime) {
  const roots = started?.runtimeWorkspaceRoots;
  const readOnly = runtime.config.permissions[runtime.permissions].filesystem[":workspace_roots"] === "read";
  if (started?.activePermissionProfile?.id !== runtime.permissions
    || !Array.isArray(roots) || roots.length !== 1 || roots[0] !== runtime.runtimeWorkspaceRoots[0]
    || !Array.isArray(started.instructionSources) || started.instructionSources.length
    || started.sandbox?.type !== (readOnly ? "readOnly" : "workspaceWrite")
    || started.sandbox.networkAccess !== false
    || started.sandbox.type === "workspaceWrite" && (started.sandbox.excludeSlashTmp !== true
      || started.sandbox.excludeTmpdirEnvVar !== true || started.sandbox.writableRoots?.length)) {
    throw unavailable();
  }
}
