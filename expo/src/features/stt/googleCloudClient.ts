import type { StreamingSttUsage } from "./streamingSttClient";

export type GoogleSttRegion = "us" | "asia-northeast1";
export type GoogleSttModel = "chirp_3" | "long" | "short";

export type GoogleCloudStatus = {
  status: "idle" | "authenticating" | "connected" | "error";
  message?: string;
  account?: string;
  projectId?: string;
  usage?: StreamingSttUsage;
  sttRegion?: GoogleSttRegion;
  sttModel?: GoogleSttModel;
};

function endpoint(runnerUrl: string, path: string) {
  return `${String(runnerUrl || "").trim().replace(/\/$/, "")}${path}`;
}

async function request(
  runnerUrl: string,
  runnerToken: string,
  path: string,
  init: RequestInit = {}
) {
  const token = String(runnerToken || "").trim();
  if (!token) throw new Error("Runner token is required.");
  const response = await fetch(endpoint(runnerUrl, path), {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.message || `Runner request failed (${response.status}).`));
  return payload;
}

export async function getGoogleCloudStatus(runnerUrl: string, runnerToken: string) {
  return await request(runnerUrl, runnerToken, "/google-cloud/status") as GoogleCloudStatus;
}

export async function saveGoogleCloudSettings(
  runnerUrl: string,
  runnerToken: string,
  settings: {
    projectId?: string;
    monthlyLimitMinutes?: number;
    sttRegion?: GoogleSttRegion;
    sttModel?: GoogleSttModel;
  }
) {
  return request(runnerUrl, runnerToken, "/google-cloud/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function startGoogleCloudAuth(runnerUrl: string, runnerToken: string) {
  return request(runnerUrl, runnerToken, "/google-cloud/auth/start", { method: "POST" });
}

export async function cancelGoogleCloudAuth(runnerUrl: string, runnerToken: string) {
  return request(runnerUrl, runnerToken, "/google-cloud/auth/cancel", { method: "POST" });
}

export async function disconnectGoogleCloud(runnerUrl: string, runnerToken: string) {
  return request(runnerUrl, runnerToken, "/google-cloud/auth/disconnect", { method: "POST" });
}
