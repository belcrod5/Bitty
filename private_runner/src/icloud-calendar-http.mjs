import { requireRunnerAuthentication, RUNNER_AUTHENTICATION } from "./runner-login-http.mjs";
import { ICLOUD_MESSAGES } from "./icloud-calendar-service.mjs";

export function createICloudCalendarHttpHandler({ service, readJsonBody, json }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith("/calendar/icloud/")) return false;
    res.setHeader("Cache-Control", "no-store");
    if (!requireRunnerAuthentication(req, res, json)) return true;
    try {
      let result;
      if (req.method === "GET" && pathname === "/calendar/icloud/status") result = await service.status();
      else if (req.method === "POST" && pathname === "/calendar/icloud/test") result = await service.test(await readJsonBody(req, 4096), req[RUNNER_AUTHENTICATION]);
      else if (req.method === "PUT" && pathname === "/calendar/icloud/connection") result = await service.save(await readJsonBody(req, 4096), req[RUNNER_AUTHENTICATION]);
      else if (req.method === "PATCH" && pathname === "/calendar/icloud/connection") result = await service.setEnabled((await readJsonBody(req, 4096))?.enabled);
      else if (req.method === "DELETE" && pathname === "/calendar/icloud/connection") result = await service.disconnect();
      else { json(res, 404, { error: "not_found" }); return true; }
      json(res, 200, result);
    } catch (failure) {
      const code = Object.hasOwn(ICLOUD_MESSAGES, failure?.code) ? failure.code : "icloud_connection_failed";
      json(res, Number(failure?.status) >= 400 && Number(failure?.status) <= 599 ? failure.status : 503, { error: code, message: ICLOUD_MESSAGES[code] });
    }
    return true;
  };
}
