import { json } from "./http-json.mjs";

export const RUNNER_AUTHENTICATION = Symbol("runner.authentication");
export function requireRunnerAuthentication(req, res, respond = json) {
  if (req[RUNNER_AUTHENTICATION]) return true;
  respond(res, 401, { error: "authentication_required" });
  return false;
}
export function runnerBearerToken(req) {
  const authorization = req.headers?.authorization;
  const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(authorization);
  return match ? match[1] : "";
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw Object.assign(new Error("invalid_authentication"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error("invalid_authentication"), { status: 400 }); }
}

export function createRunnerLoginHttp({ service, location = async () => "不明" }) {
  async function authenticate(req, local = false) {
    const context = await service.authenticate(runnerBearerToken(req), { local });
    req[RUNNER_AUTHENTICATION] = context;
    return context;
  }
  function wrap(handler, { local = false, tunnel = false } = {}) {
    return async (req, res) => {
      let pathname;
      res.setHeader("Cache-Control", "no-store");
      try {
        pathname = new URL(req.url, "http://runner.local").pathname;
        if (req.method === "GET" && pathname === "/health" && !req.headers.authorization) return json(res, 200, { ok: true });
        const publicAuth = req.method === "POST" && ["/auth/login/start", "/auth/login/complete", "/auth/recovery/start", "/auth/recovery/prepare", "/auth/recovery/complete"].includes(pathname);
        if (!publicAuth) await authenticate(req, local);
        const context = req[RUNNER_AUTHENTICATION];
        if (pathname.startsWith("/auth/")) {
          const post = req.method === "POST";
          let result;
          if (post && pathname === "/auth/login/start") result = await service.startLogin(await body(req));
          else if (post && pathname === "/auth/login/complete") result = await service.completeLogin(await body(req), { location: tunnel ? await location(req) : "不明" });
          else if (post && pathname === "/auth/reauth/start") result = await service.startReauthentication(await body(req), context);
          else if (post && pathname === "/auth/reauth/complete") result = await service.completeReauthentication(await body(req), context);
          else if (post && pathname === "/auth/recovery/start") result = await service.startRecovery(await body(req));
          else if (post && pathname === "/auth/recovery/prepare") result = await service.prepareRecovery(await body(req));
          else if (post && pathname === "/auth/recovery/complete") result = await service.completeRecovery(await body(req));
          else if (req.method === "GET" && pathname === "/auth/session") result = service.sessionInfo(context);
          else if (req.method === "GET" && pathname === "/auth/devices") result = service.listDevices(context);
          else if (post && pathname === "/auth/logout") result = await service.revoke(context, context.sessionId);
          else if (req.method === "DELETE" && /^\/auth\/devices\/[a-f0-9-]{36}$/.test(pathname)) result = await service.revoke(context, pathname.slice("/auth/devices/".length));
          else if (local && context?.local && post && pathname === "/auth/setup/start") result = await service.startSetup(await body(req));
          else if (local && context?.local && post && pathname === "/auth/setup/prepare") result = await service.prepareSetup(await body(req));
          else if (local && context?.local && post && pathname === "/auth/setup/complete") result = await service.completeSetup(await body(req));
          else if (local && context?.local && post && pathname === "/auth/setup/reset") {
            const input = await body(req);
            if (input.confirm !== "RESET OWNER") return json(res, 400, { error: "invalid_authentication" });
            result = await service.resetOwner();
          } else return json(res, 404, { error: "not_found" });
          return json(res, 200, result);
        }
        return await handler(req, res);
      } catch (failure) {
        if (res.headersSent) { res.destroy(); return; }
        const status = Number(failure.status) || 503;
        return json(res, status, { error: failure.status ? failure.code || failure.message : "authentication_unavailable" });
      }
    };
  }
  return { wrap, authenticate };
}
