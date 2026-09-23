import { useCallback, useEffect, useRef, useState } from "react";
import { NativeEventEmitter, NativeModules, type EmitterSubscription } from "react-native";

export const LIVE_PCM_FORMAT = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
} as const;

export const supportsLivePcmCapture = true;

type NativeMicrophone = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

const microphone = NativeModules.BittyMicrophone as NativeMicrophone | undefined;

export function useLivePcmCapture(onPcm: (pcm: Uint8Array) => void, onError?: (error: unknown) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const subscriptionsRef = useRef<EmitterSubscription[]>([]);
  const onPcmRef = useRef(onPcm);
  const onErrorRef = useRef(onError);
  onPcmRef.current = onPcm;
  onErrorRef.current = onError;

  const stop = useCallback(async () => {
    subscriptionsRef.current.forEach((subscription) => subscription.remove());
    subscriptionsRef.current = [];
    setIsRecording(false);
    await microphone?.stop();
  }, []);

  const start = useCallback(async () => {
    if (!microphone) {
      throw new Error("Mac音声入力モジュールがありません。macOSアプリを再ビルドしてください。");
    }
    const emitter = new NativeEventEmitter(microphone as never);
    subscriptionsRef.current = [
      emitter.addListener("BittyMicrophoneData", ({ data }: { data: string }) => {
        try {
          const binary = globalThis.atob(data);
          const pcm = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) pcm[index] = binary.charCodeAt(index);
          onPcmRef.current(pcm);
        } catch (error) {
          onErrorRef.current?.(error);
        }
      }),
      emitter.addListener("BittyMicrophoneError", () => {
        onErrorRef.current?.(new Error("Macのマイク音声を読み取れませんでした。"));
      }),
    ];
    try {
      await microphone.start();
      setIsRecording(true);
    } catch (error) {
      await stop();
      throw error;
    }
  }, [stop]);

  useEffect(() => () => {
    subscriptionsRef.current.forEach((subscription) => subscription.remove());
    void microphone?.stop();
  }, []);

  return { isRecording, start, stop };
}
