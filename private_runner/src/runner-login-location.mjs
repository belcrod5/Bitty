import { createPublicKey, verify } from "node:crypto";

// Display-only metadata. LAN callers never enter this verifier; an Access assertion
// alone cannot turn a caller-supplied location header into trusted proxy metadata.
export function createRunnerLoginLocation({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const domain = String(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "").trim();
  const audience = String(env.CLOUDFLARE_ACCESS_AUDIENCE || "").trim();
  const issuer = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) ? domain : "";
  let keys = null, fetchedAt = 0;
  return async (req) => {
    if (!issuer || !audience) return "不明";
    try {
      const assertion = req.headers?.["cf-access-jwt-assertion"];
      if (typeof assertion !== "string" || assertion.length > 16000) return "不明";
      const parts = assertion.split(".");
      if (parts.length !== 3) return "不明";
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (header.alg !== "RS256" || typeof header.kid !== "string" || claims.iss !== issuer
        || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)
        || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()
        || !Number.isFinite(claims.iat) || claims.iat * 1000 > now() + 30000
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now()))) return "不明";
      if (!keys || now() - fetchedAt > 10 * 60000) {
        const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return "不明";
        const content = await response.text();
        if (content.length > 100000) return "不明";
        keys = JSON.parse(content).keys; fetchedAt = now();
      }
      const key = keys?.find((item) => item.kid === header.kid && item.kty === "RSA");
      if (!key || !verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) return "不明";
      const values = ["cf-region", "cf-ipcity", "cf-ipcountry"].map((name) => {
        const value = req.headers?.[name];
        return typeof value === "string" && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
      }).filter(Boolean);
      return values.join(" ") || "不明";
    } catch { return "不明"; }
  };
}
