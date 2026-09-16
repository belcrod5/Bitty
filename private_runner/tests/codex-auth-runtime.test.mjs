import test from "node:test";
import assert from "node:assert/strict";
import { createCodexAuthRuntime } from "../src/codex-auth-runtime.mjs";

function service({ activeId = "one", profiles = { one: "acct-one", two: "acct-two" } } = {}) {
  const calls = [];
  let marker = activeId;
  let gate = "open";
  return {
    calls,
    async activeExternalTokenPayload() { return marker ? { accessToken: `access-${marker}`, chatgptAccountId: profiles[marker] } : null; },
    async activeAuthId() { return marker; },
    async externalTokenPayload(id) { calls.push(["token", id]); return { accessToken: `access-${id}`, chatgptAccountId: profiles[id] }; },
    async setActiveAuthId(id) { calls.push(["marker", id]); marker = id; },
    async closeAndDrain() { calls.push(["close"]); gate = "closing"; },
    openGate() { calls.push(["open"]); gate = "open"; },
    markUnready() { calls.push(["unready"]); gate = "unready"; },
    async withSwitch(fn) { return fn(); },
    gate: () => gate,
  };
}

function clientFactory(log, { accountId = null, failLogin = false, optionsLog = null } = {}) {
  return (options = {}) => {
    optionsLog?.push(options);
    return {
    openPromise: Promise.resolve(),
    async request(method, params) {
      log.push([method, params]);
      if (method === "account/login/start") {
        if (failLogin) throw new Error("login failed");
        return { type: "chatgptAuthTokens" };
      }
      if (method === "account/read") return accountId ? { account: { accountId: typeof accountId === "function" ? accountId() : accountId } } : {};
      return {};
    },
    notify(method, params) { log.push([method, params]); },
    close() { log.push(["close"]); },
    };
  };
}

test("initializes native mode without opening global auth", async () => {
  const auth = service({ activeId: "" });
  const runtime = createCodexAuthRuntime({ authService: auth, createClient: () => { throw new Error("must not connect"); } });
  await runtime.initialize();
  assert.equal(runtime.isReady(), true);
  assert.equal(runtime.activePayload(), null);
});

test("injects using initialize, initialized, login and account/read, then closes", async () => {
  const auth = service();
  const log = [];
  const runtime = createCodexAuthRuntime({ authService: auth, createClient: clientFactory(log, { accountId: "acct-one" }) });
  await runtime.initialize();
  assert.deepEqual(log.map(([method]) => method), ["initialize", "initialized", "account/login/start", "account/read", "close"]);
  assert.equal(log[2][1].type, "chatgptAuthTokens");
});

test("switches and writes marker only after injection", async () => {
  const auth = service();
  const log = [];
  let clientCount = 0;
  const optionsLog = [];
  const runtime = createCodexAuthRuntime({ authService: auth, createClient: clientFactory(log, { accountId: () => (++clientCount === 1 ? "acct-one" : "acct-two"), optionsLog }) });
  await runtime.initialize();
  await runtime.switchAccount("two");
  assert.deepEqual(auth.calls.map(([name]) => name), ["close", "token", "marker", "open"]);
  assert.equal(runtime.activePayload().chatgptAccountId, "acct-two");
  assert.equal(optionsLog.every((options) => options.bypassAuthGate === true), true);
});

test("returns exact refresh payload and validates account/reason", async () => {
  const auth = service();
  auth.externalTokenPayload = async (id, options) => { auth.calls.push(["refresh", id, options]); return { accessToken: "new-access", chatgptAccountId: "acct-one" }; };
  const runtime = createCodexAuthRuntime({ authService: auth, createClient: clientFactory([], { accountId: "acct-one" }) });
  await runtime.initialize();
  assert.deepEqual(await runtime.handleRefresh({ params: { reason: "unauthorized", previousAccountId: "acct-one" } }), { accessToken: "new-access", chatgptAccountId: "acct-one" });
  await assert.rejects(runtime.handleRefresh({ params: { reason: "other", previousAccountId: "acct-one" } }), /not allowed/);
  await assert.rejects(runtime.handleRefresh({ params: { reason: "unauthorized", previousAccountId: "other" } }), /mismatch/);
});

test("failed switch reloads the previous canonical token before rollback", async () => {
  const auth = service();
  auth.externalTokenPayload = async (id) => {
    auth.calls.push(["token", id]);
    return { accessToken: id === "one" ? "access-one-refreshed" : `access-${id}`, chatgptAccountId: `acct-${id}` };
  };
  const log = [];
  let count = 0;
  const runtime = createCodexAuthRuntime({
    authService: auth,
    createClient: () => {
      count += 1;
      return clientFactory(log, { accountId: count === 2 ? "acct-two" : "acct-one", failLogin: count === 2 })();
    },
  });
  await runtime.initialize();
  await assert.rejects(runtime.switchAccount("two"), /login failed/);
  assert.equal(auth.calls.filter(([name, id]) => name === "token" && id === "one").length, 1);
  const loginPayloads = log.filter(([method]) => method === "account/login/start").map(([, params]) => params);
  assert.equal(loginPayloads.at(-1).accessToken, "access-one-refreshed");
  assert.equal(runtime.activePayload().accessToken, "access-one-refreshed");
  assert.equal(runtime.isReady(), true);
  assert.equal(auth.gate(), "open");
});

test("failed switch rolls back; failed rollback leaves runtime unready", async () => {
  const auth = service();
  let count = 0;
  const runtime = createCodexAuthRuntime({
    authService: auth,
    createClient: () => {
      count += 1;
      return clientFactory([], { accountId: "acct-one", failLogin: count === 2 || count === 3 })();
    },
    rpcTimeoutMs: 20,
  });
  await runtime.initialize();
  await assert.rejects(runtime.switchAccount("two"));
  assert.equal(runtime.isReady(), false);
  assert.equal(auth.gate(), "unready");
});
