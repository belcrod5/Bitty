export function operationStore() {
  const entries = new Map();
  return {
    async inspect(subjectId, operationId, requestHash) {
      const existing = entries.get(`${subjectId}:${operationId}`);
      if (!existing) return { status: "missing" };
      if (existing.requestHash !== requestHash) return { status: "conflict" };
      return { status: "existing", runId: existing.runId, result: existing.result };
    },
    async claim(subjectId, operationId, requestHash, runId) {
      const key = `${subjectId}:${operationId}`;
      const existing = entries.get(key);
      if (existing && existing.requestHash !== requestHash) return { status: "conflict" };
      if (existing) return { status: "existing", runId: existing.runId };
      entries.set(key, { requestHash, runId, result: null });
      return { status: "claimed", runId };
    },
    async complete(subjectId, operationId, result) {
      entries.get(`${subjectId}:${operationId}`).result = result;
    },
  };
}

export function sessionStore() {
  const bindings = new Map();
  const modes = new Map();
  const directoryLastReadAt = new Map();
  const key = (ref) => `${ref.backendId}:${ref.nativeSessionId}`;
  return {
    async bind(ref, canonicalCwd, mode, options = {}) {
      const existingMode = modes.get(key(ref));
      if (existingMode && existingMode.mode !== mode) return { status: "mode_conflict", mode: existingMode.mode };
      const existingBinding = bindings.get(key(ref));
      if (existingBinding && existingBinding.canonicalCwd !== canonicalCwd && options.reconcileCwd !== true) {
        return { status: "cwd_conflict", binding: existingBinding };
      }
      const binding = { ...(existingBinding || ref), canonicalCwd };
      if (Object.hasOwn(options, "settings")) {
        if (options.settings?.modelId) binding.modelId = options.settings.modelId;
        else delete binding.modelId;
        if (options.settings?.reasoningEffort) binding.reasoningEffort = options.settings.reasoningEffort;
        else delete binding.reasoningEffort;
      }
      bindings.set(key(ref), binding);
      modes.set(key(ref), existingMode || { mode, lease: null, generation: 0 });
      return { status: "bound", mode };
    },
    async getBinding(ref) { return bindings.get(key(ref)) || null; },
    async getReadState(_ref, cwd) {
      const lastReadAt = directoryLastReadAt.get(cwd);
      return lastReadAt ? { lastReadAt, revision: 1 } : null;
    },
    async getMode(ref) { return modes.get(key(ref)) || null; },
    async acquire({ sessionRef, mode, owner, runId }) {
      const entry = modes.get(key(sessionRef)) || { mode, lease: null, generation: 0 };
      if (entry.mode !== mode) return { status: "mode_conflict", mode: entry.mode };
      if (entry.lease) return { status: "busy", lease: entry.lease };
      entry.generation += 1;
      entry.lease = { generation: entry.generation, owner, runId, state: "active" };
      modes.set(key(sessionRef), entry);
      return { status: "acquired", lease: entry.lease };
    },
    async settle(ref, generation, state) {
      const entry = modes.get(key(ref));
      if (!entry?.lease || entry.lease.generation !== generation) return { status: "stale" };
      if (state === "released") entry.lease = null;
      else entry.lease = { ...entry.lease, state: "recovering" };
      return { status: state };
    },
    async updateIdentity(ref, generation, nativeProcessIdentity) {
      const entry = modes.get(key(ref));
      if (!entry?.lease || entry.lease.generation !== generation) return { status: "stale" };
      entry.lease = { ...entry.lease, nativeProcessIdentity };
      return { status: "updated" };
    },
    async handoff(ref, mode, options = {}) {
      const entry = modes.get(key(ref)) || { lease: null, generation: 0 };
      if (entry.mode === mode) {
        if (options.clearSettings) {
          const binding = bindings.get(key(ref));
          if (binding) {
            delete binding.modelId;
            delete binding.reasoningEffort;
          }
        }
        return { status: "unchanged", mode };
      }
      if (entry.lease) return { status: "busy", mode: entry.mode, lease: entry.lease };
      entry.mode = mode;
      modes.set(key(ref), entry);
      if (options.clearSettings) {
        const binding = bindings.get(key(ref));
        if (binding) {
          delete binding.modelId;
          delete binding.reasoningEffort;
        }
      }
      return { status: "changed", mode };
    },
    async setSettings(ref, settings = {}) {
      const binding = bindings.get(key(ref));
      if (!binding) return { status: "missing" };
      if (settings.modelId) binding.modelId = settings.modelId;
      else delete binding.modelId;
      if (settings.reasoningEffort) binding.reasoningEffort = settings.reasoningEffort;
      else delete binding.reasoningEffort;
      return { status: "updated" };
    },
    async recordActivity(ref, canonicalCwd) {
      const binding = bindings.get(key(ref));
      if (!binding || binding.canonicalCwd !== canonicalCwd) return { status: "missing" };
      return { status: "updated" };
    },
    setDirectoryLastReadAt(cwd, lastReadAt) { directoryLastReadAt.set(cwd, lastReadAt); },
  };
}

export function status() {
  return {
    backendId: "test",
    available: true,
    readiness: { ready: true },
    capabilities: {
      action: {
        policyProfiles: [{ id: "ask", label: "Ask", interactive: true, decisions: ["allow", "deny"] }],
      },
    },
  };
}

export function startRequest(overrides = {}) {
  return {
    backendId: "test",
    cwd: "/workspace",
    input: { blocks: [{ type: "text", text: "hello" }] },
    clientOperationId: "operation-1",
    ...overrides,
  };
}
