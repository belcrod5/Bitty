import { runnerSettingsRequest } from "./runnerSettingsRequest";

export type SttProvider = "google" | "macos";

export async function getSttProvider(runnerUrl: string, runnerToken: string): Promise<SttProvider> {
  const result = await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/settings");
  if (result.provider !== "google" && result.provider !== "macos") throw new Error("Invalid speech settings response.");
  return result.provider;
}

export async function saveSttProvider(runnerUrl: string, runnerToken: string, provider: SttProvider) {
  await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/settings", {
    method: "PUT",
    body: JSON.stringify({ provider }),
  });
}
