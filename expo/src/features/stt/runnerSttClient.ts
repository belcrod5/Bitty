export type RunnerSttRequest = {
  baseUrl: string;
  runnerToken: string;
  recordingUri: string;
  mimeType: string;
  fileName: string;
  language: string;
  // 録音ファイルのバイト数(既知の場合)。通信量計測がアップロードの上りを
  // 推定計上するためにファイルパートの size として渡す。
  audioBytes?: number;
  sttMeta?: Record<string, unknown>;
  signal?: AbortSignal;
};

export async function requestRunnerSttTranscript(options: RunnerSttRequest) {
  const baseUrl = String(options.baseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("runner URL is empty");
  }

  const mimeType = String(options.mimeType || "audio/m4a").trim() || "audio/m4a";
  const fileName = String(options.fileName || "recording.m4a").trim() || "recording.m4a";
  const language = String(options.language || "").trim();
  const recordingUri = String(options.recordingUri || "").trim();
  if (!recordingUri) {
    throw new Error("recordingUri is required for runner /stt");
  }

  const audioBytes = Number(options.audioBytes);
  const form = new FormData();
  form.append("file", {
    uri: recordingUri,
    name: fileName,
    type: mimeType,
    // RNはuri/name/type以外のプロパティを無視するため送信内容には影響しない。
    ...(Number.isFinite(audioBytes) && audioBytes > 0 ? { size: Math.floor(audioBytes) } : {}),
  } as any);
  if (language) {
    form.append("language", language);
  }
  if (options.sttMeta) {
    for (const [key, value] of Object.entries(options.sttMeta)) {
      if (value == null) continue;
      form.append(key, String(value));
    }
  }
  const response = await fetch(`${baseUrl}/stt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(options.runnerToken || "").trim()}`,
    },
    signal: options.signal,
    body: form,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  return String(data?.transcript || "");
}
