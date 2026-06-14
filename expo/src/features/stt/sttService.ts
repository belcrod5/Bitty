import { requestIosNativeSttTranscript } from "./iosNativeSttClient";
import { requestRunnerSttTranscript } from "./runnerSttClient";
import type { SttProvider } from "./sttConfig";

export type SttServiceRequest = {
  provider: SttProvider;
  language: string;
  timeoutMs: number;
  signal?: AbortSignal;
  recordingUri?: string;
  mimeType: string;
  fileName: string;
  baseUrl: string;
  runnerToken: string;
  sttMeta?: Record<string, unknown>;
};

export async function transcribeWithConfiguredProvider(options: SttServiceRequest) {
  if (options.provider === "ios_native_direct") {
    throw new Error("ios_native_direct does not support recorded-file transcription.");
  }

  if (options.provider === "ios_native") {
    return requestIosNativeSttTranscript({
      uri: String(options.recordingUri || "").trim(),
      language: options.language,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  if (options.provider === "ios_native_runner" || options.provider === "runner") {
    return requestRunnerSttTranscript({
      baseUrl: options.baseUrl,
      runnerToken: options.runnerToken,
      recordingUri: String(options.recordingUri || "").trim(),
      mimeType: options.mimeType,
      fileName: options.fileName,
      language: options.language,
      signal: options.signal,
      sttMeta: options.sttMeta,
    });
  }

  return requestRunnerSttTranscript({
    baseUrl: options.baseUrl,
    runnerToken: options.runnerToken,
    recordingUri: String(options.recordingUri || "").trim(),
    mimeType: options.mimeType,
    fileName: options.fileName,
    language: options.language,
    signal: options.signal,
    sttMeta: options.sttMeta,
  });
}
