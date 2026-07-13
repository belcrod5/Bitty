import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-approval-hook-"));

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
// The hook never reads the key file (sendToDevice is mocked below), so a placeholder
// path is enough to flip PUSH_ENABLED on for this process.
process.env.APNS_KEY_PATH = path.join(tempDir, "AuthKey_TEST.p8");
process.env.APNS_KEY_ID = "TESTKEYID1";
process.env.APPLE_TEAM_ID = "TESTTEAMID";
process.env.PUSH_DEVICE_STORE_PATH = path.join(tempDir, "push_devices.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const {
  handleCodexRelayUpstreamMessage,
  forwardCodexRelayClientData,
  pushDeviceStore,
  apnsClient,
  pushSummarizer,
  sendTurnCompletedPush,
  derivePushDirectoryTitle,
} = __TESTING__;

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function approvalMessage(rpcId, params = {}, method = "item/commandExecution/requestApproval") {
  return JSON.stringify({ id: rpcId, method, params });
}

function makeRelay(overrides = {}) {
  return {
    relayId: "relay-approval-test",
    remote: "test",
    endpoint: "/codex-ws",
    clients: new Set(),
    threadId: "thread-1",
    threadCwd: "",
    turnStatus: "",
    turnStarted: false,
    turnCompleted: false,
    pendingApprovalRequestIds: new Set(),
    requestIdByRpcId: new Map(),
    requestMethodByRpcId: new Map(),
    requestMetaByRpcId: new Map(),
    runnerWsLlmOperationId: "",
    runnerWsLlmSessionId: "",
    lastSeq: 0,
    eventLog: [],
    closed: false,
    ...overrides,
  };
}

// Fire-and-forget: give the microtask queue (device list read + mocked send) time to settle.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("sends exactly one push for a new approval request with the command in the body", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-1", apnsToken: "token-1", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (token, payload, opts) => {
    calls.push({ token, payload, opts });
    return { ok: true, status: 200 };
  };
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    await pushDeviceStore.removeDevice("device-1");
  });

  const relay = makeRelay();
  handleCodexRelayUpstreamMessage(relay, approvalMessage(42, { command: "npm", args: ["test"] }), false);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "token-1");
  assert.equal(calls[0].payload.aps.alert.title, "承認リクエスト");
  assert.match(calls[0].payload.aps.alert.body, /npm test/);
  assert.equal(calls[0].payload.aps.sound, "default");
  assert.equal(calls[0].payload.aps.category, "APPROVAL_REQUEST");
  assert.equal(calls[0].payload.aps["interruption-level"], "time-sensitive");
  assert.equal(calls[0].payload.approvalId, "relay-approval-test:42");
  assert.equal(calls[0].payload.sessionId, "thread-1");
});

test("falls back to a generic file-change label when no command is present", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-fc", apnsToken: "token-fc", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (token, payload) => {
    calls.push({ token, payload });
    return { ok: true, status: 200 };
  };
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    await pushDeviceStore.removeDevice("device-fc");
  });

  const relay = makeRelay();
  handleCodexRelayUpstreamMessage(relay, approvalMessage(43, {}, "item/fileChange/requestApproval"), false);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.aps.alert.body, "ファイル変更");
});

test("does not send a duplicate push for a replayed/duplicate approval message", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-2", apnsToken: "token-2", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (token, payload) => {
    calls.push({ token, payload });
    return { ok: true, status: 200 };
  };
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    await pushDeviceStore.removeDevice("device-2");
  });

  const relay = makeRelay();
  const data = approvalMessage(7, { command: "rm", args: ["-rf", "tmp"] });
  handleCodexRelayUpstreamMessage(relay, data, false);
  handleCodexRelayUpstreamMessage(relay, data, false);
  await flush();

  assert.equal(calls.length, 1);
});

test("skips sending once the approval was answered before the send could go out", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-3", apnsToken: "token-3", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (token, payload) => {
    calls.push({ token, payload });
    return { ok: true, status: 200 };
  };
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    await pushDeviceStore.removeDevice("device-3");
  });

  const relay = makeRelay();
  handleCodexRelayUpstreamMessage(relay, approvalMessage(9, { command: "git", args: ["push"] }), false);
  // Simulate the live WS (or the /push/approvals respond endpoint) answering the approval
  // before the fire-and-forget push send has resolved its device list lookup.
  relay.pendingApprovalRequestIds.delete(9);
  await flush();

  assert.equal(calls.length, 0);
});

test("does not attempt to send when no devices are registered", async () => {
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  };
  try {
    const relay = makeRelay();
    handleCodexRelayUpstreamMessage(relay, approvalMessage(11, { command: "ls" }), false);
    await flush();
    assert.equal(calls.length, 0);
  } finally {
    apnsClient.sendToDevice = originalSendToDevice;
  }
});

test("removes a device that APNs reports as unregistered (410)", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-410", apnsToken: "token-410", env: "sandbox" });
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async () => ({ ok: false, status: 410, reason: "Unregistered" });
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
  });

  const relay = makeRelay();
  handleCodexRelayUpstreamMessage(relay, approvalMessage(12, { command: "ls" }), false);
  await flush();

  const devices = await pushDeviceStore.listDevices();
  assert.equal(devices.some((device) => device.deviceId === "device-410"), false);
});

test("derives the push title from the working directory's trailing segment", () => {
  assert.equal(derivePushDirectoryTitle("/Volumes/SSD-500GB-SanDisk/work/test_folder"), "test_folder");
  assert.equal(derivePushDirectoryTitle("/work/test_folder/"), "test_folder");
  assert.equal(derivePushDirectoryTitle("relative/dir"), "dir");
  assert.equal(derivePushDirectoryTitle("  /work/spaced  "), "spaced");
  assert.equal(derivePushDirectoryTitle(""), "");
  assert.equal(derivePushDirectoryTitle(null), "");
  // Degenerate segmentless path: same as the app's deriveDirectoryDisplayName, the raw
  // path itself is returned rather than falling back to the fixed title.
  assert.equal(derivePushDirectoryTitle("/"), "/");
});

test("uses the relay's working-directory basename as the approval push title", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-title", apnsToken: "token-title", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  apnsClient.sendToDevice = async (token, payload) => {
    calls.push({ token, payload });
    return { ok: true, status: 200 };
  };
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    await pushDeviceStore.removeDevice("device-title");
  });

  const relay = makeRelay({ threadCwd: "/Volumes/SSD-500GB-SanDisk/work/test_folder" });
  handleCodexRelayUpstreamMessage(relay, approvalMessage(21, { command: "npm", args: ["test"] }), false);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.aps.alert.title, "test_folder");
});

test("captures the session cwd from client thread/start / turn/start RPCs", () => {
  const relay = makeRelay({ upstreamOpen: false, pendingToUpstream: [] });
  forwardCodexRelayClientData(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: { cwd: "/work/project-a" },
  }), false);
  assert.equal(relay.threadCwd, "/work/project-a");

  // A later turn/start with a cwd updates it; one without a cwd leaves it untouched.
  forwardCodexRelayClientData(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/start",
    params: { threadId: "thread-1", cwd: "/work/project-b" },
  }), false);
  assert.equal(relay.threadCwd, "/work/project-b");

  forwardCodexRelayClientData(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: { threadId: "thread-1" },
  }), false);
  assert.equal(relay.threadCwd, "/work/project-b");
});

test("captures the session cwd from the upstream thread/resume result as a fallback", () => {
  const relay = makeRelay();
  relay.requestMethodByRpcId.set(5, "thread/resume");
  handleCodexRelayUpstreamMessage(relay, JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    result: { thread: { id: "thread-1", cwd: "/work/from-upstream" } },
  }), false);
  assert.equal(relay.threadCwd, "/work/from-upstream");
});

test("turn-completed push uses the directory basename title with a fixed-title fallback", async (t) => {
  await pushDeviceStore.upsertDevice({ deviceId: "device-tc", apnsToken: "token-tc", env: "sandbox" });
  const calls = [];
  const originalSendToDevice = apnsClient.sendToDevice;
  const originalSummarize = pushSummarizer.summarize;
  apnsClient.sendToDevice = async (token, payload) => {
    calls.push({ token, payload });
    return { ok: true, status: 200 };
  };
  pushSummarizer.summarize = async (text) => String(text || "");
  t.after(async () => {
    apnsClient.sendToDevice = originalSendToDevice;
    pushSummarizer.summarize = originalSummarize;
    await pushDeviceStore.removeDevice("device-tc");
  });

  await sendTurnCompletedPush({
    sessionId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-1",
    previewText: "done",
    directory: "/Volumes/SSD-500GB-SanDisk/work/test_folder",
  });
  await sendTurnCompletedPush({
    sessionId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-2",
    previewText: "done",
    directory: "",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.aps.alert.title, "test_folder");
  assert.equal(calls[1].payload.aps.alert.title, "タスク完了");
});
