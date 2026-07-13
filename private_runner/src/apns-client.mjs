import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

// Apple allows a JWT to be reused for up to 60 minutes; refresh a bit earlier to stay safe.
const JWT_MAX_AGE_MS = 50 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Builds an ES256-signed APNs provider authentication token (RFC 7519).
// Exported standalone so header/claims/signature can be verified without a live network call.
export function buildApnsJwt({ keyId, teamId, privateKeyPem, issuedAtMs = Date.now() }) {
  const kid = String(keyId || "").trim();
  const iss = String(teamId || "").trim();
  if (!kid || !iss || !privateKeyPem) {
    throw new Error("buildApnsJwt requires keyId, teamId, and privateKeyPem");
  }
  const header = { alg: "ES256", kid };
  const claims = { iss, iat: Math.floor(issuedAtMs / 1000) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const privateKey = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

export function resolveApnsHost(env) {
  return String(env || "").trim().toLowerCase() === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";
}

export function maskApnsToken(token) {
  const value = String(token || "");
  return value.length <= 6 ? "***" : `...${value.slice(-6)}`;
}

// Minimal direct-to-APNs HTTP/2 client using only Node built-ins (no npm dependency).
// deps.http2Connect / deps.readKeyFile / deps.now are injectable so tests can avoid
// touching the real filesystem, clock, or network.
export function createApnsClient(config = {}, deps = {}) {
  const keyPath = String(config.keyPath || "").trim();
  const keyId = String(config.keyId || "").trim();
  const teamId = String(config.teamId || "").trim();
  const topic = String(config.topic || "app.bitty.mobile").trim();
  const defaultEnv = String(config.env || "sandbox").trim().toLowerCase() === "production"
    ? "production"
    : "sandbox";
  const requestTimeoutMs = Math.max(1000, Number(config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS));

  const readKeyFile = deps.readKeyFile || ((filePath) => readFileSync(filePath, "utf8"));
  const http2Connect = deps.http2Connect || ((authority) => http2.connect(authority));
  const now = deps.now || (() => Date.now());

  const enabled = Boolean(keyPath && keyId && teamId);

  let cachedPrivateKeyPem = null;
  let cachedJwt = null;
  let cachedJwtIssuedAtMs = 0;

  function loadPrivateKeyPem() {
    if (!cachedPrivateKeyPem) {
      cachedPrivateKeyPem = readKeyFile(keyPath);
    }
    return cachedPrivateKeyPem;
  }

  function getAuthorizationToken() {
    const nowMs = now();
    if (cachedJwt && (nowMs - cachedJwtIssuedAtMs) < JWT_MAX_AGE_MS) {
      return cachedJwt;
    }
    cachedJwt = buildApnsJwt({ keyId, teamId, privateKeyPem: loadPrivateKeyPem(), issuedAtMs: nowMs });
    cachedJwtIssuedAtMs = nowMs;
    return cachedJwt;
  }

  async function sendToDevice(deviceToken, payload, opts = {}) {
    if (!enabled) throw new Error("apns_client_disabled");
    const token = String(deviceToken || "").trim();
    if (!token) throw new Error("apns_device_token_required");
    const host = resolveApnsHost(opts.env || defaultEnv);
    const authorization = `bearer ${getAuthorizationToken()}`;
    const body = JSON.stringify(payload || {});

    return await new Promise((resolve, reject) => {
      let settled = false;
      const session = http2Connect(`https://${host}`);
      const timer = setTimeout(() => {
        finish(reject, new Error(`apns request timeout (${requestTimeoutMs}ms)`));
      }, requestTimeoutMs);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          session.close();
        } catch {}
        fn(value);
      }

      session.on("error", (err) => finish(reject, err));

      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization,
        "apns-topic": topic,
        "apns-push-type": opts.pushType || "alert",
        "apns-priority": String(opts.priority || 10),
      });

      let status = 0;
      let responseBody = "";
      req.on("response", (headers) => {
        status = Number(headers[":status"] || 0);
      });
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        responseBody += chunk;
      });
      req.on("end", () => {
        let reason = "";
        if (responseBody) {
          try {
            reason = String(JSON.parse(responseBody)?.reason || "");
          } catch {}
        }
        finish(resolve, { ok: status === 200, status, reason });
      });
      req.on("error", (err) => finish(reject, err));
      req.end(body);
    });
  }

  return {
    enabled,
    topic,
    env: defaultEnv,
    sendToDevice,
  };
}
