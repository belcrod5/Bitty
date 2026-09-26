import { createGoogleStreamingSttHandler } from "./google-streaming-stt.mjs";
import { createMacosStreamingSttHandler } from "./macos-streaming-stt.mjs";

export function createStreamingSttHandler({ sttSettings, googleCloudService, usageLedger, googleHandler, macosHandler }) {
  const providers = {
    google: googleHandler || createGoogleStreamingSttHandler({ googleCloudService, usageLedger }),
    macos: macosHandler || createMacosStreamingSttHandler(),
  };
  return (ws) => {
    let connecting = false;
    const onFirstMessage = async (raw, isBinary) => {
      if (connecting) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "error", code: "protocol_order",
            message: "Unexpected speech stream control message", retryable: false,
          }));
          ws.close(1000);
        }
        return;
      }
      connecting = true;
      try {
        const sttProvider = await sttSettings.get();
        if (ws.readyState !== 1) return;
        const provider = providers[sttProvider];
        if (!provider) throw new Error("Unknown speech provider");
        ws.off("message", onFirstMessage);
        provider(ws);
        ws.emit("message", raw, isBinary);
      } catch {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "error", code: "stt_provider_unavailable",
            message: "音声認識の設定を読み込めませんでした。", retryable: false,
          }));
          ws.close(1000);
        }
      }
    };
    ws.on("message", onFirstMessage);
  };
}
