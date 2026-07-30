import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";

const { __TESTING__ } = await import("../src/server-runtime.mjs?session-summaries-endpoint");
const { server } = __TESTING__;

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function post(baseUrl, body, authorization = "Bearer test-runner-token") {
  return fetch(`${baseUrl}/session-summaries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body,
  });
}

test("POST /session-summaries requires runner authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({
      directory: "/workspace",
      sessionIds: [],
    }), "");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");
  });
});

test("POST /session-summaries rejects malformed JSON with a controlled 400", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, "{");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_json");
  });
});

test("POST /session-summaries enforces its 32 KiB body limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, `"${"x".repeat(33 * 1024)}"`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "request_body_too_large");
  });
});

test("POST /session-summaries returns service validation errors as 400", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({ sessionIds: [] }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_directory");
  });
});
