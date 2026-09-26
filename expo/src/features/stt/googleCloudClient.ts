import type { StreamingSttUsage } from "./streamingSttClient";
import { runnerSettingsRequest } from "./runnerSettingsRequest";

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

export async function getGoogleCloudStatus(runnerUrl: string, runnerToken: string) {
  return await runnerSettingsRequest(runnerUrl, runnerToken, "/google-cloud/status") as GoogleCloudStatus;
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
  return runnerSettingsRequest(runnerUrl, runnerToken, "/google-cloud/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function startGoogleCloudAuth(runnerUrl: string, runnerToken: string) {
  return runnerSettingsRequest(runnerUrl, runnerToken, "/google-cloud/auth/start", { method: "POST" });
}

export async function cancelGoogleCloudAuth(runnerUrl: string, runnerToken: string) {
  return runnerSettingsRequest(runnerUrl, runnerToken, "/google-cloud/auth/cancel", { method: "POST" });
}

export async function disconnectGoogleCloud(runnerUrl: string, runnerToken: string) {
  return runnerSettingsRequest(runnerUrl, runnerToken, "/google-cloud/auth/disconnect", { method: "POST" });
}
