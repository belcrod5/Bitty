import assert from "node:assert/strict";
import test from "node:test";

import { createAgentService } from "../src/agent/agent-service.mjs";
import { createClaudeBackend } from "../src/claude-backend.mjs";
import { createCodexBackend } from "../src/codex-turn-execution.mjs";
import { operationStore, sessionStore, startRequest } from "./agent-service-fixtures.mjs";

function modelService(options) {
  return createAgentService({
    operationStore: operationStore(),
    sessionStore: sessionStore(),
    workspaceAdmission: { assertAllowed: async (_subjectId, cwd) => cwd },
    resolveCanonicalCwd: async (cwd) => cwd,
    ...options,
  });
}


async function complete(run) {
  for await (const event of run.events) void event;
  await run.completion;
}

test("Agent model validation rejects unknown models and honors per-model effort catalogs", async () => {
  let starts = 0;
  const backend = {
    backendId: "test",
    getStatus: async () => ({
      backendId: "test",
      available: true,
      readiness: { ready: true },
      capabilities: {
        model: {
          select: true,
          effort: true,
          effortOptions: ["low", "medium", "high", "ultra"],
          catalog: [
            { modelId: "strict-model", effortOptions: ["low", "high"] },
            { modelId: "no-effort-model", effortOptions: [] },
            { modelId: "legacy-model" },
          ],
        },
      },
    }),
    resolveSessionCwd: async () => "/workspace",
    async startTurn({ emit, resolveSession }) {
      starts += 1;
      await resolveSession({ backendId: "test", nativeSessionId: `session-${starts}` });
      emit("turn.started", {});
      return { outcome: "completed" };
    },
  };
  let runId = 0;
  const service = modelService({
    backends: [backend],
    generateRunId: () => `run-${++runId}`,
  });

  await assert.rejects(
    service.startTurn(startRequest({ model: "unknown-model", effort: "high", clientOperationId: "unknown-model" }), { subjectId: "user-1" }),
    (error) => error.code === "capability_unsupported" && /model value/.test(error.message),
  );
  await assert.rejects(
    service.startTurn(startRequest({ model: "strict-model", effort: "ultra", clientOperationId: "strict-effort" }), { subjectId: "user-1" }),
    (error) => error.code === "capability_unsupported" && /effort value/.test(error.message),
  );
  await assert.rejects(
    service.startTurn(startRequest({ model: "no-effort-model", effort: "low", clientOperationId: "empty-effort" }), { subjectId: "user-1" }),
    (error) => error.code === "capability_unsupported" && /effort value/.test(error.message),
  );
  assert.equal(starts, 0);

  await complete(await service.startTurn(
    startRequest({ model: "legacy-model", effort: "ultra", clientOperationId: "legacy-backend-effort" }),
    { subjectId: "user-1" },
  ));
  await complete(await service.startTurn(
    startRequest({ model: "strict-model", effort: "high", clientOperationId: "strict-supported-effort" }),
    { subjectId: "user-1" },
  ));
  assert.equal(starts, 2);
});

test("Codex model discovery failure leaves Claude aliases and status independent", async () => {
  const codex = createCodexBackend({
    createClient: () => ({
      openPromise: Promise.resolve(),
      notify() {},
      async request(method) {
        if (method === "model/list") throw new Error("model catalog unavailable");
        return {};
      },
      close() {},
    }),
    resolveSessionCwd: async () => "/workspace",
  });
  const realClaude = createClaudeBackend({ sessionStore: { getBinding: async () => null } });
  let claudeStarts = 0;
  const claude = {
    ...realClaude,
    async startTurn({ emit, resolveSession }) {
      claudeStarts += 1;
      await resolveSession({ backendId: "claude", nativeSessionId: "claude-session" });
      emit("turn.started", {});
      return { outcome: "completed" };
    },
  };
  const service = modelService({
    backends: [codex, claude],
    generateRunId: () => "claude-run",
  });

  const statuses = await service.getStatuses();
  const codexStatus = statuses.find((entry) => entry.backendId === "codex");
  const claudeStatus = statuses.find((entry) => entry.backendId === "claude");
  assert.equal(codexStatus.available, false);
  assert.equal(codexStatus.readiness.ready, false);
  assert.equal("capabilities" in codexStatus, false);
  assert.equal(claudeStatus.available, true);
  assert.deepEqual(claudeStatus.capabilities.model.catalog.map((model) => model.modelId), ["haiku", "sonnet", "opus", "fable"]);

  await assert.rejects(
    service.startTurn(startRequest({ backendId: "claude", model: "unknown", effort: "high", clientOperationId: "claude-unknown" }), { subjectId: "user-1" }),
    (error) => error.code === "capability_unsupported" && /model value/.test(error.message),
  );
  await complete(await service.startTurn(
    startRequest({ backendId: "claude", model: "sonnet", effort: "high", clientOperationId: "claude-sonnet" }),
    { subjectId: "user-1" },
  ));
  assert.equal(claudeStarts, 1);
});
