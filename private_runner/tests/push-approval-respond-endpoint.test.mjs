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
const { server, codexWsRelaysById } = __TESTING__;

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
