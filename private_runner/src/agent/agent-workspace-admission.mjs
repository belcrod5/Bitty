import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import { agentError } from "./agent-protocol.mjs";

const PREPARE_TTL_MS = 5 * 60 * 1000;
const PREPARE_MAX_ENTRIES = 100;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fileIdentity(stat) {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

export function createAgentWorkspaceAdmission({ store, fileSystem = fs, now = () => Date.now(), onRevoke } = {}) {
  if (
    typeof store?.list !== "function" ||
    typeof store?.approve !== "function" ||
    typeof store?.revoke !== "function"
  ) throw new TypeError("workspace store is required");

  const prepared = new Map();

  async function inspect(rawPath) {
    const requested = String(rawPath || "").trim();
    if (!requested || !path.isAbsolute(requested)) {
      throw agentError("turn_rejected", "workspace path must be absolute");
    }
    let canonicalRoot;
    let stat;
    try {
      canonicalRoot = await fileSystem.realpath(requested);
      stat = await fileSystem.stat(canonicalRoot);
    } catch {
      throw agentError("turn_rejected", "workspace directory was not found");
    }
    if (!stat.isDirectory()) throw agentError("turn_rejected", "workspace path must be a directory");
    const parsedRoot = path.parse(canonicalRoot).root;
    let home = os.homedir();
    try { home = await fileSystem.realpath(home); } catch {}
    if (canonicalRoot === parsedRoot || canonicalRoot === home) {
      throw agentError("turn_rejected", "filesystem root and user home cannot be approved as a workspace");
    }
    return { requestedPath: path.resolve(requested), canonicalRoot: path.resolve(canonicalRoot), identity: fileIdentity(stat) };
  }

  async function prepare(subjectIdRaw, rawPath) {
    const subjectId = String(subjectIdRaw || "").trim();
    if (!subjectId) throw agentError("turn_rejected", "authenticated subject is required");
    for (const [requestId, entry] of prepared) {
      if (entry.expiresAt < now()) prepared.delete(requestId);
    }
    if (prepared.size >= PREPARE_MAX_ENTRIES) {
      throw agentError("turn_rejected", "too many workspace confirmations are pending");
    }
    const inspected = await inspect(rawPath);
    const requestId = randomBytes(24).toString("base64url");
    prepared.set(requestId, {
      subjectId,
      ...inspected,
      expiresAt: now() + PREPARE_TTL_MS,
    });
    return {
      requestId,
      canonicalRoot: inspected.canonicalRoot,
      expiresAt: new Date(now() + PREPARE_TTL_MS).toISOString(),
      warning: "Claude Code will be allowed to read and modify files inside this workspace.",
    };
  }

  async function confirm(subjectIdRaw, requestIdRaw) {
    const subjectId = String(subjectIdRaw || "").trim();
    const requestId = String(requestIdRaw || "").trim();
    const entry = prepared.get(requestId);
    prepared.delete(requestId);
    if (!entry || entry.subjectId !== subjectId || entry.expiresAt < now()) {
      throw agentError("turn_rejected", "workspace confirmation expired");
    }
    const inspected = await inspect(entry.requestedPath);
    if (inspected.canonicalRoot !== entry.canonicalRoot || inspected.identity !== entry.identity) {
      throw agentError("turn_rejected", "workspace changed during confirmation");
    }
    return await store.approve(subjectId, inspected.canonicalRoot, inspected.identity);
  }

  async function list(subjectIdRaw) {
    return await store.list(String(subjectIdRaw || "").trim());
  }

  async function assertAllowed(subjectIdRaw, rawCwd) {
    const subjectId = String(subjectIdRaw || "").trim();
    const inspected = await inspect(rawCwd);
    const roots = await store.list(subjectId);
    for (const entry of roots) {
      try {
        const currentRoot = await inspect(entry.canonicalRoot);
        if (
          currentRoot.canonicalRoot === entry.canonicalRoot &&
          currentRoot.identity === entry.identity &&
          inside(entry.canonicalRoot, inspected.canonicalRoot)
        ) return inspected.canonicalRoot;
      } catch {}
    }
    throw agentError("turn_rejected", "workspace has not been approved or changed after approval");
  }

  async function revoke(subjectIdRaw, rawRoot) {
    const subjectId = String(subjectIdRaw || "").trim();
    const requestedRoot = String(rawRoot || "").trim();
    if (!subjectId || !path.isAbsolute(requestedRoot)) {
      throw agentError("turn_rejected", "canonical workspace root is required");
    }
    const canonicalRoot = path.resolve(requestedRoot);
    const revoked = await store.revoke(subjectId, canonicalRoot);
    if (revoked) await onRevoke?.({ subjectId, canonicalRoot });
    return revoked;
  }

  return { prepare, confirm, list, assertAllowed, revoke };
}
