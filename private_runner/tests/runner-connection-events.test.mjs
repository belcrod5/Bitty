import assert from "node:assert/strict";
import test from "node:test";

function mockReq({ ip = "203.0.113.10", ray = "ray-1", userAgent = "BittyTest/1.0" } = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      "cf-connecting-ip": ip,
      "cf-ray": ray,
      "cf-ipcountry": "JP",
      "user-agent": userAgent,
    },
  };
}

test("coalesces repeated runner token mismatches from the same client", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-coalesce`);

  mod.recordRunnerConnectionRejected(mockReq({ ray: "ray-1" }), {
    route: "runner-ws",
    endpoint: "/runner-ws",
    reason: "token_mismatch",
    tokenSource: "authorization",
    hasAuthHeaderToken: true,
    hasQueryToken: false,
  });
  mod.recordRunnerConnectionRejected(mockReq({ ray: "ray-2" }), {
    route: "runner-ws",
    endpoint: "/runner-ws",
    reason: "token_mismatch",
    tokenSource: "authorization",
    hasAuthHeaderToken: true,
    hasQueryToken: false,
  });
  mod.recordRunnerConnectionRejected(mockReq({ ray: "ray-3" }), {
    route: "runner-ws",
    endpoint: "/runner-ws",
    reason: "token_mismatch",
    tokenSource: "authorization",
    hasAuthHeaderToken: true,
    hasQueryToken: false,
  });

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 50 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].reason, "token_mismatch");
  assert.equal(result.events[0].repeatCount, 3);
  assert.equal(result.events[0].seq, 3);
  assert.equal(result.events[0].cfRay, "ray-3");
  assert.equal(result.latestSeq, 3);
});

test("keeps distinct rejection sources separate", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-separate`);

  for (const userAgent of ["BittyTest/1.0", "OtherClient/1.0"]) {
    mod.recordRunnerConnectionRejected(mockReq({ userAgent }), {
      route: "runner-ws",
      endpoint: "/runner-ws",
      reason: "token_mismatch",
      tokenSource: "authorization",
      hasAuthHeaderToken: true,
      hasQueryToken: false,
    });
  }

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 50 });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.repeatCount), [1, 1]);
});

test("normal connection churn does not evict rejection history", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-retention`);

  mod.recordRunnerConnectionRejected(mockReq(), {
    route: "runner-ws",
    endpoint: "/runner-ws",
    reason: "token_mismatch",
    tokenSource: "authorization",
    hasAuthHeaderToken: true,
    hasQueryToken: false,
  });

  for (let index = 0; index < 250; index += 1) {
    const connectionId = `connection-${index}`;
    mod.recordRunnerConnectionOpened(mockReq(), {
      connectionId,
      route: "runner-ws",
      endpoint: "/runner-ws",
    });
    mod.recordRunnerConnectionClosed(mockReq(), {
      connectionId,
      route: "runner-ws",
      endpoint: "/runner-ws",
    });
  }

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 200 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].reason, "token_mismatch");
  assert.equal(result.allowedEvents.length, 1);
  assert.equal(result.allowedEvents[0].repeatCount, 250);
  assert.equal(result.latestSeq, 501);
  assert.equal(result.latestAllowedEvent?.connectionId, "connection-249");
  assert.equal(result.activeCount, 0);
});

test("keeps the newest 200 rejection and error events", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-attention-limit`);

  for (let index = 0; index < 205; index += 1) {
    mod.recordRunnerConnectionError(mockReq(), {
      connectionId: `connection-${index}`,
      route: "runner-ws",
      endpoint: "/runner-ws",
      reason: `error-${index}`,
    });
  }

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 200 });
  assert.equal(result.events.length, 200);
  assert.equal(result.events[0].seq, 6);
  assert.equal(result.events[199].seq, 205);
  assert.equal(result.latestSeq, 205);
});

test("rejection history cannot evict allowed history", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-separate-limits`);

  mod.recordRunnerConnectionOpened(mockReq(), {
    connectionId: "allowed-1",
    route: "runner-ws",
    endpoint: "/runner-ws",
  });

  for (let index = 0; index < 250; index += 1) {
    mod.recordRunnerConnectionError(mockReq(), {
      connectionId: `error-${index}`,
      route: "runner-ws",
      endpoint: "/runner-ws",
      reason: `error-${index}`,
    });
  }

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 200 });
  assert.equal(result.events.length, 200);
  assert.equal(result.allowedEvents.length, 1);
  assert.equal(result.allowedEvents[0].connectionId, "allowed-1");
});

test("keeps the newest 200 distinct allowed sources", async () => {
  const mod = await import(`../src/runner-connection-events.mjs?test=${Date.now()}-allowed-limit`);

  for (let index = 0; index < 205; index += 1) {
    const connectionId = `allowed-${index}`;
    mod.recordRunnerConnectionOpened(mockReq({ userAgent: `BittyTest/${index}` }), {
      connectionId,
      route: "runner-ws",
      endpoint: "/runner-ws",
    });
    mod.recordRunnerConnectionClosed(mockReq(), {
      connectionId,
      route: "runner-ws",
      endpoint: "/runner-ws",
    });
  }

  const result = mod.listRunnerConnectionEvents({ sinceSeq: 0, limit: 200 });
  assert.equal(result.allowedEvents.length, 200);
  assert.equal(result.allowedEvents[0].connectionId, "allowed-5");
  assert.equal(result.allowedEvents[199].connectionId, "allowed-204");
  assert.equal(result.events.length, 0);
});
