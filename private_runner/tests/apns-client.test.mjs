import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  buildApnsJwt,
  createApnsClient,
  maskApnsToken,
  resolveApnsHost,
} from "../src/apns-client.mjs";

function generateEcKeyPair() {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

function decodeJwtPart(part) {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

test("buildApnsJwt produces a header/claims/signature verifiable with the public key", () => {
  const { privateKey, publicKey } = generateEcKeyPair();
  const jwt = buildApnsJwt({
    keyId: "KEYID1234",
    teamId: "TEAM1234AB",
    privateKeyPem: privateKey,
    issuedAtMs: Date.parse("2026-07-13T00:00:00.000Z"),
  });
  const [headerPart, claimsPart, signaturePart] = jwt.split(".");
  assert.deepEqual(decodeJwtPart(headerPart), { alg: "ES256", kid: "KEYID1234" });
  assert.deepEqual(decodeJwtPart(claimsPart), {
    iss: "TEAM1234AB",
    iat: Math.floor(Date.parse("2026-07-13T00:00:00.000Z") / 1000),
  });

  const signingInput = `${headerPart}.${claimsPart}`;
  const signature = Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const isValid = verify(
    "SHA256",
    Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  assert.equal(isValid, true);
});

test("buildApnsJwt requires keyId, teamId, and a private key", () => {
  const { privateKey } = generateEcKeyPair();
  assert.throws(() => buildApnsJwt({ teamId: "T", privateKeyPem: privateKey }));
  assert.throws(() => buildApnsJwt({ keyId: "K", privateKeyPem: privateKey }));
  assert.throws(() => buildApnsJwt({ keyId: "K", teamId: "T" }));
});

test("resolveApnsHost selects the sandbox host by default and production only when requested", () => {
  assert.equal(resolveApnsHost(""), "api.sandbox.push.apple.com");
  assert.equal(resolveApnsHost("sandbox"), "api.sandbox.push.apple.com");
  assert.equal(resolveApnsHost("bogus"), "api.sandbox.push.apple.com");
  assert.equal(resolveApnsHost("production"), "api.push.apple.com");
  assert.equal(resolveApnsHost("PRODUCTION"), "api.push.apple.com");
});

test("maskApnsToken keeps only the last few characters", () => {
  assert.equal(maskApnsToken("abcdef1234567890"), "...567890");
  assert.equal(maskApnsToken("abc"), "***");
  assert.equal(maskApnsToken(""), "***");
});

function createFakeHttp2({ status = 200, reasonBody = "" } = {}) {
  const calls = [];
  function connect(authority) {
    const session = new EventEmitter();
    session.close = () => {};
    session.request = (headers) => {
      const req = new EventEmitter();
      req.setEncoding = () => {};
      req.end = (body) => {
        calls.push({ authority, headers, body });
        queueMicrotask(() => {
          req.emit("response", { ":status": status });
          if (reasonBody) req.emit("data", reasonBody);
          req.emit("end");
        });
      };
      return req;
    };
    return session;
  }
  return { connect, calls };
}

function baseConfig(overrides = {}) {
  return {
    keyPath: "/tmp/does-not-matter.p8",
    keyId: "KEYID1234",
    teamId: "TEAM1234AB",
    topic: "app.bitty.mobile",
    env: "sandbox",
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const { privateKey } = generateEcKeyPair();
  return {
    readKeyFile: () => privateKey,
    now: () => Date.parse("2026-07-13T00:00:00.000Z"),
    ...overrides,
  };
}

test("createApnsClient is disabled when key config is incomplete", async () => {
  const client = createApnsClient({ keyId: "", teamId: "", keyPath: "" }, baseDeps());
  assert.equal(client.enabled, false);
  await assert.rejects(client.sendToDevice("device-token", {}), /apns_client_disabled/);
});

test("sendToDevice posts to the sandbox host with the expected headers and returns ok on 200", async () => {
  const fakeHttp2 = createFakeHttp2({ status: 200 });
  const client = createApnsClient(baseConfig(), baseDeps({ http2Connect: fakeHttp2.connect }));
  const result = await client.sendToDevice("device-token-abc", { aps: { alert: { body: "hi" } } });
  assert.deepEqual(result, { ok: true, status: 200, reason: "" });
  assert.equal(fakeHttp2.calls.length, 1);
  const call = fakeHttp2.calls[0];
  assert.equal(call.authority, "https://api.sandbox.push.apple.com");
  assert.equal(call.headers[":path"], "/3/device/device-token-abc");
  assert.equal(call.headers["apns-topic"], "app.bitty.mobile");
  assert.match(call.headers.authorization, /^bearer /);
  assert.equal(JSON.parse(call.body).aps.alert.body, "hi");
});

test("sendToDevice uses the production host when env is overridden per call", async () => {
  const fakeHttp2 = createFakeHttp2({ status: 200 });
  const client = createApnsClient(baseConfig({ env: "sandbox" }), baseDeps({ http2Connect: fakeHttp2.connect }));
  await client.sendToDevice("device-token-abc", {}, { env: "production" });
  assert.equal(fakeHttp2.calls[0].authority, "https://api.push.apple.com");
});

test("sendToDevice reports 410 Unregistered so the caller can prune the device", async () => {
  const fakeHttp2 = createFakeHttp2({ status: 410, reasonBody: JSON.stringify({ reason: "Unregistered" }) });
  const client = createApnsClient(baseConfig(), baseDeps({ http2Connect: fakeHttp2.connect }));
  const result = await client.sendToDevice("stale-token", {});
  assert.deepEqual(result, { ok: false, status: 410, reason: "Unregistered" });
});

test("getAuthorizationToken caches the JWT within the TTL and only reads the key file once", async () => {
  const fakeHttp2 = createFakeHttp2({ status: 200 });
  let readCount = 0;
  let nowMs = Date.parse("2026-07-13T00:00:00.000Z");
  const { privateKey } = generateEcKeyPair();
  const client = createApnsClient(baseConfig(), {
    http2Connect: fakeHttp2.connect,
    readKeyFile: () => {
      readCount += 1;
      return privateKey;
    },
    now: () => nowMs,
  });

  await client.sendToDevice("token-1", {});
  await client.sendToDevice("token-1", {});
  assert.equal(readCount, 1);
  const firstAuth = fakeHttp2.calls[0].headers.authorization;
  const secondAuth = fakeHttp2.calls[1].headers.authorization;
  assert.equal(firstAuth, secondAuth);

  nowMs += 51 * 60 * 1000;
  await client.sendToDevice("token-1", {});
  const thirdAuth = fakeHttp2.calls[2].headers.authorization;
  assert.notEqual(thirdAuth, firstAuth);
});
