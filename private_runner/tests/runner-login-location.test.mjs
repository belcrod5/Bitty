import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRunnerLoginLocation } from "../src/runner-login-location.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { ...publicKey.export({ format: "jwk" }), kid: "test-key" };
const now = Date.parse("2026-11-08T00:00:00Z");
const issuer = "https://example.cloudflareaccess.com";
function assertion(overrides = {}, header = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = encode({ alg: "RS256", kid: key.kid, ...header }) + "." + encode({ iss: issuer, aud: ["expected-app"], iat: now / 1000 - 10, exp: now / 1000 + 60, ...overrides });
  return data + "." + sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
}
function verifier(options = {}) {
  return createRunnerLoginLocation({ env: { CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer, CLOUDFLARE_ACCESS_AUDIENCE: "expected-app" }, now: () => now,
    fetchImpl: async (url) => { assert.equal(url, issuer + "/cdn-cgi/access/certs"); return { ok: true, text: async () => JSON.stringify({ keys: [key] }) }; }, ...options });
}
const request = (token) => ({ headers: { "cf-access-jwt-assertion": token, "cf-region": "石川県", "cf-ipcity": "金沢市", "cf-ipcountry": "JP" } });

test("location is returned only after pinned issuer/audience/expiry/RS256 signature verification", async () => {
  assert.equal(await verifier()(request(assertion())), "石川県 金沢市 JP");
  for (const overrides of [{ iss: "https://evil.example" }, { aud: ["wrong"] }, { exp: now / 1000 - 1 }, { iat: now / 1000 + 300 }]) {
    assert.equal(await verifier()(request(assertion(overrides))), "不明");
  }
  const token = assertion();
  assert.equal(await verifier()(request(token.slice(0, -20) + "a".repeat(20))), "不明");
  assert.equal(await verifier()(request(assertion({}, { alg: "HS256" }))), "不明");
});

test("missing configuration/assertion/certs and invalid location values fail to unknown", async () => {
  assert.equal(await verifier({ env: {} })(request(assertion())), "不明");
  assert.equal(await verifier()({ headers: { "cf-ipcity": "forged city" } }), "不明");
  assert.equal(await verifier({ fetchImpl: async () => { throw new Error("offline"); } })(request(assertion())), "不明");
  const req = request(assertion()); req.headers["cf-ipcity"] = "x\nInjected";
  assert.equal(await verifier()(req), "石川県 JP");
});
