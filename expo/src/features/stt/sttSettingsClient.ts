import { runnerSettingsRequest } from "./runnerSettingsRequest";

export type SttProvider = "google" | "macos";
export type SttCorrectionSettings = { model: string; effort: string };
export type SttCorrectionContext = { role: "user" | "assistant"; text: string };

export async function getSttSettings(runnerUrl: string, runnerToken: string) {
  const result = await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/settings");
  if (result.provider !== "google" && result.provider !== "macos") throw new Error("Invalid speech settings response.");
  const correction = result.correction as SttCorrectionSettings | undefined;
  if (!correction || typeof correction.model !== "string" || typeof correction.effort !== "string") {
    throw new Error("Invalid correction settings response.");
  }
  return { provider: result.provider as SttProvider, correction };
}

export async function saveSttProvider(runnerUrl: string, runnerToken: string, provider: SttProvider) {
  await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/settings", {
    method: "PUT",
    body: JSON.stringify({ provider }),
  });
}

export async function saveSttCorrection(runnerUrl: string, runnerToken: string, correction: SttCorrectionSettings) {
  await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/settings", {
    method: "PATCH", body: JSON.stringify({ correction }),
  });
}

export async function listSttCorrectionModels(runnerUrl: string, runnerToken: string) {
  const result = await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/models");
  if (!Array.isArray(result.models)) throw new Error("Invalid model list response.");
  return result.models as { modelId: string; label: string; effortOptions: string[] }[];
}

export async function correctSttTranscript(runnerUrl: string, runnerToken: string, text: string,
  context: SttCorrectionContext[], signal?: AbortSignal) {
  const result = await runnerSettingsRequest(runnerUrl, runnerToken, "/stt/correct", {
    method: "POST", body: JSON.stringify({ text, context }), signal,
  });
  if (typeof result.changed !== "boolean" || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Invalid correction response.");
  }
  return { changed: result.changed && result.text !== text, text: result.text };
}
