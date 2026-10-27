import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareOrchestratorRuntime, assertOrchestratorRuntime } from "../src/orchestrator-runtime-profile.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "owner");
  const sibling = path.join(root, "sibling");
  await fs.mkdir(workspace); await fs.mkdir(sibling);
  const ownSkill = path.join(workspace, "SKILL.md");
  const otherSkill = path.join(sibling, "SKILL.md");
  await fs.writeFile(ownSkill, "own"); await fs.writeFile(otherSkill, "other");
  const linked = path.join(workspace, "outside-skill.md");
  await fs.symlink(otherSkill, linked);
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    if (method === "config/read") return { config: { mcp_servers: { connected: { enabled: true }, disabled: { enabled: false } } } };
    if (method === "skills/list") return { data: [{ cwd: params.cwds[0], errors: [], skills: [
      { path: ownSkill }, { path: otherSkill }, { path: linked }, { path: path.join(root, "missing.md") },
    ] }] };
    throw new Error(method);
  } };
  return { workspace, sibling, ownSkill, otherSkill, linked, calls, client };
}

const response = (runtime, readOnly = false) => ({ activePermissionProfile: { id: runtime.permissions },
  runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots, instructionSources: [], sandbox: readOnly
    ? { type: "readOnly", networkAccess: false }
    : { type: "workspaceWrite", networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true, writableRoots: [] } });

test("each profile grants only its owned workspace and removes inherited knowledge and external tools", async (t) => {
  const f = await fixture(t);
  const runtime = await prepareOrchestratorRuntime(f.client, { workspaceDirectory: f.workspace, cwd: f.workspace });
  const canonical = await fs.realpath(f.workspace);
  assert.deepEqual(runtime.runtimeWorkspaceRoots, [canonical]);
  assert.deepEqual(runtime.config.permissions[runtime.permissions], {
    filesystem: { ":minimal": "read", ":workspace_roots": "write" }, network: { enabled: false },
  });
  assert.equal(runtime.config.skills.config.some((skill) => skill.path === f.ownSkill), false);
  for (const outside of [f.otherSkill, f.linked]) assert.deepEqual(runtime.config.skills.config.find((skill) => skill.path === outside), { path: outside, enabled: false });
  assert.equal(runtime.config.skills.config.length, 3);
  assert.deepEqual(runtime.config.mcp_servers, { connected: { enabled: false }, disabled: { enabled: false } });
  assert.equal(Object.values(runtime.config.features).every((enabled) => enabled === false), true);
  assert.equal(runtime.config.features.browser_use, false);
  assert.equal(runtime.config.features.computer_use, false);
  assert.deepEqual(runtime.config.memories, { generate_memories: false, use_memories: false });
  assert.equal(runtime.config.apps._default.enabled, false);
  assert.equal(runtime.config.project_doc_max_bytes, 0);
  assert.equal(runtime.config.web_search, "disabled");
  assert.deepEqual(runtime.config.shell_environment_policy, { inherit: "none" });
  assert.deepEqual(f.calls.map((call) => call.method), ["config/read", "skills/list"]);
  assert.equal(f.calls[1].params.forceReload, true);
  assert.doesNotThrow(() => assertOrchestratorRuntime(response(runtime), runtime));
  const next = await prepareOrchestratorRuntime(f.client, { workspaceDirectory: f.workspace, cwd: f.workspace });
  assert.notEqual(next.permissions, runtime.permissions);
});

test("summary and learning profiles retain restricted reads without a writable workspace", async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.workspace, "summary"); await fs.mkdir(nested);
  const runtime = await prepareOrchestratorRuntime(f.client, { workspaceDirectory: f.workspace, cwd: nested, readOnly: true });
  assert.equal(runtime.config.permissions[runtime.permissions].filesystem[":workspace_roots"], "read");
  assert.doesNotThrow(() => assertOrchestratorRuntime(response(runtime, true), runtime));
});

test("a sibling cwd, malformed discovery or unsupported runtime fails closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareOrchestratorRuntime(f.client, { workspaceDirectory: f.workspace, cwd: f.sibling }), { code: "capability_unsupported" });
  assert.equal(f.calls.length, 0);
  for (const data of [undefined, [], [{ cwd: f.workspace, errors: [{ message: "failed" }], skills: [] }],
    [{ cwd: f.sibling, errors: [], skills: [] }], [{ cwd: f.workspace, errors: [], skills: [{ path: "relative.md" }] }]]) {
    const client = { async request(method) { return method === "config/read" ? { config: {} } : { data }; } };
    await assert.rejects(prepareOrchestratorRuntime(client, { workspaceDirectory: f.workspace, cwd: f.workspace }), { code: "capability_unsupported" });
  }
  await assert.rejects(prepareOrchestratorRuntime({ request() { throw new Error("unsupported"); } },
    { workspaceDirectory: f.workspace, cwd: f.workspace }), { code: "capability_unsupported" });
});

test("startup and resume cannot silently use inherited instructions, roots or legacy broad policies", async (t) => {
  const f = await fixture(t);
  const runtime = await prepareOrchestratorRuntime(f.client, { workspaceDirectory: f.workspace, cwd: f.workspace });
  for (const patch of [
    { activePermissionProfile: null }, { activePermissionProfile: { id: "other" } },
    { runtimeWorkspaceRoots: [f.sibling] }, { runtimeWorkspaceRoots: [...runtime.runtimeWorkspaceRoots, f.sibling] },
    { instructionSources: ["/global/AGENTS.md"] }, { sandbox: { type: "dangerFullAccess" } },
    { sandbox: { ...response(runtime).sandbox, networkAccess: true } },
    { sandbox: { ...response(runtime).sandbox, excludeSlashTmp: false } },
    { sandbox: { ...response(runtime).sandbox, writableRoots: [f.sibling] } },
  ]) assert.throws(() => assertOrchestratorRuntime({ ...response(runtime), ...patch }, runtime), { code: "capability_unsupported" });
});
