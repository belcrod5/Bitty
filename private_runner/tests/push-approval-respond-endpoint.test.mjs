import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-approval-respond-"));

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.APNS_KEY_PATH = path.join(tempDir, "AuthKey_TEST.p8");
process.env.APNS_KEY_ID = "TESTKEYID1";
process.env.APPLE_TEAM_ID = "TESTTEAMID";
process.env.PUSH_DEVICE_STORE_PATH = path.join(tempDir, "push_devices.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server, codexWsRelaysById, pendingAgentApprovals, agentService } = __TESTING__;

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function makeRelay(relayId, overrides = {}) {
  const relay = {
    relayId,
    upstreamOpen: false,
    upstreamWs: null,
    pendingToUpstream: [],
    clients: new Set(),
    threadId: "thread-1",
    pendingApprovalRequestIds: new Set(),
    requestIdByRpcId: new Map(),
    requestMethodByRpcId: new Map(),
    requestMetaByRpcId: new Map(),
    runnerWsLlmOperationId: "",
    runnerWsLlmSessionId: "",
    upstreamInitializeResultSeen: false,
    upstreamInitializeResult: null,
    upstreamInitializedNotificationForwarded: false,
    lastSeq: 0,
    eventLog: [],
    closed: false,
    ...overrides,
  };
  codexWsRelaysById.set(relayId, relay);
  return relay;
}

async function postRespond(baseUrl, approvalId, body, headers = {}) {
  return fetch(`${baseUrl}/push/approvals/${approvalId}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("requires a bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await postRespond(baseUrl, "relay-x:1", { approved: true }, {});
    assert.equal(response.status, 401);
  });
});

test("rejects an incorrect bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await postRespond(baseUrl, "relay-x:1", { approved: true }, {
      authorization: "Bearer wrong-token",
    });
    assert.equal(response.status, 401);
  });
});

test("rejects a malformed approval id", async () => {
  await withServer(async (baseUrl) => {
    const response = await postRespond(baseUrl, "not-an-id", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 400);
  });
});

test("returns 400 (and keeps the process alive) for invalid percent-encoding in the approval id", async () => {
  await withServer(async (baseUrl) => {
    // "%E0%A4" is a truncated UTF-8 sequence: decodeURIComponent throws URIError. An
    // unguarded call would crash the whole runner via an unhandled rejection.
    const malformed = await fetch(`${baseUrl}/push/approvals/%E0%A4/respond`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-runner-token" },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "invalid_approval_id");

    // The server must still answer subsequent requests normally.
    makeRelay("relay-alive-check", { pendingApprovalRequestIds: new Set([2]) });
    const followUp = await postRespond(baseUrl, "relay-alive-check:2", { approved: false }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(followUp.status, 200);
  });
});

test("returns 409 when the relay is unknown", async () => {
  await withServer(async (baseUrl) => {
    const response = await postRespond(baseUrl, "relay-missing:1", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 409);
  });
});

test("returns 400 when approved is not a boolean and leaves the approval pending", async () => {
  await withServer(async (baseUrl) => {
    const relay = makeRelay("relay-bad-body", { pendingApprovalRequestIds: new Set([3]) });
    const response = await postRespond(baseUrl, "relay-bad-body:3", {}, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 400);
    assert.equal(relay.pendingApprovalRequestIds.has(3), true);
  });
});

test("returns 409 when the approval id is not pending", async () => {
  await withServer(async (baseUrl) => {
    makeRelay("relay-not-pending", { pendingApprovalRequestIds: new Set() });
    const response = await postRespond(baseUrl, "relay-not-pending:5", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 409);
  });
});

test("forwards an approve decision to the relay and clears the pending id", async () => {
  await withServer(async (baseUrl) => {
    const relay = makeRelay("relay-approve", { pendingApprovalRequestIds: new Set([8]) });
    const response = await postRespond(baseUrl, "relay-approve:8", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, enabled: true, approved: true });
    assert.equal(relay.pendingApprovalRequestIds.has(8), false);
    assert.equal(relay.pendingToUpstream.length, 1);
    const forwarded = JSON.parse(relay.pendingToUpstream[0].data);
    assert.deepEqual(forwarded, { jsonrpc: "2.0", id: 8, result: { decision: "accept" } });
  });
});

test("forwards a decline decision", async () => {
  await withServer(async (baseUrl) => {
    const relay = makeRelay("relay-decline", { pendingApprovalRequestIds: new Set([9]) });
    const response = await postRespond(baseUrl, "relay-decline:9", { approved: false }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, enabled: true, approved: false });
    const forwarded = JSON.parse(relay.pendingToUpstream[0].data);
    assert.equal(forwarded.result.decision, "decline");
  });
});

test("returns 409 on a second respond call for the same approval id (already answered)", async () => {
  await withServer(async (baseUrl) => {
    makeRelay("relay-dup", { pendingApprovalRequestIds: new Set([10]) });
    const first = await postRespond(baseUrl, "relay-dup:10", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(first.status, 200);

    const second = await postRespond(baseUrl, "relay-dup:10", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(second.status, 409);
  });
});

test("routes neutral approve and deny decisions through AgentService", async (t) => {
  const originalRespondToAction = agentService.respondToAction;
  const calls = [];
  agentService.respondToAction = async (request) => { calls.push(request); };
  t.after(() => { agentService.respondToAction = originalRespondToAction; });

  await withServer(async (baseUrl) => {
    for (const [suffix, approved, decision] of [["1", true, "allow"], ["2", false, "deny"]]) {
      const approvalId = `agent-approval:00000000-0000-4000-8000-00000000000${suffix}`;
      pendingAgentApprovals.set(approvalId, {
        runId: `run-${suffix}`, requestId: `request-${suffix}`, responding: false,
      });
      const response = await postRespond(baseUrl, approvalId, { approved }, {
        authorization: "Bearer test-runner-token",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, enabled: true, approved });
      assert.equal(calls.at(-1).decision, decision);
    }
  });
});

test("reserves a neutral approval before awaiting AgentService", async (t) => {
  const originalRespondToAction = agentService.respondToAction;
  let release;
  const calls = [];
  agentService.respondToAction = (request) => {
    calls.push(request);
    return new Promise((resolve) => { release = resolve; });
  };
  t.after(() => { agentService.respondToAction = originalRespondToAction; });

  await withServer(async (baseUrl) => {
    const approvalId = "agent-approval:00000000-0000-4000-8000-000000000003";
    pendingAgentApprovals.set(approvalId, { runId: "run-3", requestId: "request-3", responding: false });
    const first = postRespond(baseUrl, approvalId, { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await postRespond(baseUrl, approvalId, { approved: false }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(duplicate.status, 409);
    assert.equal(calls.length, 1);
    release();
    assert.equal((await first).status, 200);
  });
});

test("normalizes expired neutral approvals to 409 and rejects malformed neutral ids", async (t) => {
  const originalRespondToAction = agentService.respondToAction;
  agentService.respondToAction = async () => {
    const error = new Error("expired");
    error.code = "action_expired";
    throw error;
  };
  t.after(() => { agentService.respondToAction = originalRespondToAction; });

  await withServer(async (baseUrl) => {
    const malformed = await postRespond(baseUrl, "agent-approval:not-a-uuid", { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(malformed.status, 400);

    const approvalId = "agent-approval:00000000-0000-4000-8000-000000000004";
    pendingAgentApprovals.set(approvalId, { runId: "run-4", requestId: "request-4", responding: false });
    const expired = await postRespond(baseUrl, approvalId, { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(expired.status, 409);
    assert.equal(pendingAgentApprovals.has(approvalId), false);
  });
});

test("releases a neutral response reservation after an unexpected failure", async (t) => {
  const originalRespondToAction = agentService.respondToAction;
  let attempts = 0;
  agentService.respondToAction = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
  };
  t.after(() => { agentService.respondToAction = originalRespondToAction; });

  await withServer(async (baseUrl) => {
    const approvalId = "agent-approval:00000000-0000-4000-8000-000000000005";
    const entry = { runId: "run-5", requestId: "request-5", responding: false };
    pendingAgentApprovals.set(approvalId, entry);
    const first = await postRespond(baseUrl, approvalId, { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(first.status, 500);
    assert.equal(entry.responding, false);

    const retry = await postRespond(baseUrl, approvalId, { approved: true }, {
      authorization: "Bearer test-runner-token",
    });
    assert.equal(retry.status, 200);
    assert.equal(attempts, 2);
  });
});
