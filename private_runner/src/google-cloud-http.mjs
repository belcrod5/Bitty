export function createGoogleCloudHttpHandler({
  runnerToken,
  parseAuthToken,
  readJsonBody,
  json,
  googleCloudService,
  usageLedger,
}) {
  const safeFailureMessage = (error) => {
    const message = String(error?.message || "");
    if (/projectId is invalid|monthlyLimitMinutes must be a positive integer|sttRegion is invalid|sttModel is invalid/i.test(message)) return message;
    if (/permissions must be|must be a regular file|must not be a symbolic link|must be a directory/i.test(message)) {
      return message;
    }
    if (/^Google Cloud authentication (?:is already in progress|failed|timed out|validation failed)/i.test(message)) {
      return message;
    }
    if (/^Unable to start Google Cloud authentication/i.test(message)) return message;
    return "Google Cloud request failed";
  };

  const authorize = (req, res) => {
    if (!runnerToken) {
      json(res, 500, { error: "runner_token_missing", message: "RUNNER_TOKEN is required" });
      return false;
    }
    if (parseAuthToken(req) !== runnerToken) {
      json(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  };

  const fullStatus = async () => {
    const status = await googleCloudService.status();
    let usage = null;
    if (status.projectId) {
      const snapshot = await usageLedger.get(status.projectId);
      usage = {
        usedSeconds: snapshot.usedSeconds,
        limitSeconds: snapshot.limitSeconds,
        remainingSeconds: snapshot.remainingSeconds,
        monthUtc: snapshot.monthUtc,
        resetAt: snapshot.resetAt,
      };
    }
    return {
      status: status.status,
      message: status.message,
      account: status.account,
      projectId: status.projectId,
      sttRegion: status.sttRegion,
      sttModel: status.sttModel,
      usage,
    };
  };

  return async (req, res, pathname) => {
    if (!pathname.startsWith("/google-cloud/")) return false;
    if (!authorize(req, res)) return true;
    try {
      if (req.method === "GET" && pathname === "/google-cloud/status") {
        json(res, 200, await fullStatus());
        return true;
      }
      if (req.method === "POST" && pathname === "/google-cloud/auth/start") {
        const body = await readJsonBody(req, 16 * 1024);
        await googleCloudService.startAuthentication(body?.projectId);
        json(res, 202, await fullStatus());
        return true;
      }
      if (req.method === "POST" && pathname === "/google-cloud/auth/cancel") {
        await googleCloudService.cancelAuthentication();
        json(res, 200, await fullStatus());
        return true;
      }
      if (req.method === "POST" && pathname === "/google-cloud/auth/disconnect") {
        await googleCloudService.disconnect();
        json(res, 200, await fullStatus());
        return true;
      }
      if (req.method === "PUT" && pathname === "/google-cloud/settings") {
        const body = await readJsonBody(req, 16 * 1024);
        await googleCloudService.updateSettings({
          projectId: body?.projectId,
          monthlyLimitMinutes: body?.monthlyLimitMinutes,
          sttRegion: body?.sttRegion,
          sttModel: body?.sttModel,
        });
        json(res, 200, await fullStatus());
        return true;
      }
      json(res, 404, { error: "not_found" });
      return true;
    } catch (error) {
      const message = safeFailureMessage(error);
      const invalid = /invalid|positive integer|required/i.test(message);
      json(res, invalid ? 400 : 500, {
        error: invalid ? "google_cloud_settings_invalid" : "google_cloud_failed",
        message,
      });
      return true;
    }
  };
}
