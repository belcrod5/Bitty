import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentWorkspaceAdmission } from "../src/agent/agent-workspace-admission.mjs";

test("workspace confirmation is subject-bound, one-time, and rejects symlink replacement", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-workspace-admission-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const first = path.join(tempRoot, "first");
  const second = path.join(tempRoot, "second");
  const link = path.join(tempRoot, "selected");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.symlink(first, link);
  const approved = [];
  const admission = createAgentWorkspaceAdmission({
    store: {
      list: async () => approved,
      approve: async (subjectId, canonicalRoot, identity) => {
        const entry = { subjectId, canonicalRoot, identity, approvedAt: new Date().toISOString(), revokedAt: "" };
        approved.push(entry);
        return entry;
      },
      revoke: async () => null,
    },
  });

  const prepared = await admission.prepare("user-1", link);
  await assert.rejects(admission.confirm("user-2", prepared.requestId), /expired/);
  const replaced = await admission.prepare("user-1", link);
  await fs.unlink(link);
  await fs.symlink(second, link);
  await assert.rejects(admission.confirm("user-1", replaced.requestId), /changed/);
  const valid = await admission.prepare("user-1", link);
  await admission.confirm("user-1", valid.requestId);
  await assert.rejects(admission.confirm("user-1", valid.requestId), /expired/);
  assert.equal(await admission.assertAllowed("user-1", second), await fs.realpath(second));
  await fs.rmdir(second);
  await fs.mkdir(second);
  await assert.rejects(admission.assertAllowed("user-1", second), /changed after approval/);
});

test("rejects filesystem root, home, and home ancestors as workspaces", async () => {
  const admission = createAgentWorkspaceAdmission({
    store: { list: async () => [], approve: async () => null, revoke: async () => null },
  });
  const home = await fs.realpath(os.homedir());
  await assert.rejects(admission.prepare("user-1", home), /cannot be approved/);
  // homeの祖先(/Users等)を承認するとhome全体が許可されてしまうため拒否する
  await assert.rejects(admission.prepare("user-1", path.dirname(home)), /cannot be approved/);
  await assert.rejects(admission.prepare("user-1", path.parse(home).root), /cannot be approved/);
});

test("revokes a stored workspace after its directory has been removed", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-workspace-revoke-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace);
  const entries = new Map();
  const admission = createAgentWorkspaceAdmission({
    store: {
      list: async () => Array.from(entries.values()),
      approve: async (subjectId, canonicalRoot, identity) => {
        const entry = { subjectId, canonicalRoot, identity };
        entries.set(canonicalRoot, entry);
        return entry;
      },
      revoke: async (_subjectId, canonicalRoot) => {
        const entry = entries.get(canonicalRoot) || null;
        entries.delete(canonicalRoot);
        return entry;
      },
    },
  });
  const prepared = await admission.prepare("subject", workspace);
  await admission.confirm("subject", prepared.requestId);
  await fs.rm(workspace, { recursive: true });

  assert.equal((await admission.revoke("subject", prepared.canonicalRoot))?.canonicalRoot, prepared.canonicalRoot);
  assert.equal(entries.size, 0);
});
