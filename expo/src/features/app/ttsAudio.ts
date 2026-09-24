import { NativeModules } from "react-native";
import { Audio } from "./audio";
import type { VisualThemeTtsEffect } from "./theme/visualThemes";

type TtsEffectsModule = {
  process(uri: string, effect: VisualThemeTtsEffect, requestId: string): Promise<string>;
  cancel(requestId: string): Promise<void>;
  remove(uri: string): Promise<void>;
};

let nextRequestId = 0;

export async function createTtsSoundAsync(
  uri: string,
  status: { shouldPlay: boolean; volume: number },
  effect: VisualThemeTtsEffect | null,
  signal?: AbortSignal
): Promise<Audio.Sound> {
  if (signal?.aborted) throw new Error("TTS音声加工を中止しました。");
  if (!effect) {
    const { sound } = await Audio.Sound.createAsync({ uri }, status);
    if (signal?.aborted) {
      await sound.unloadAsync().catch(() => {});
      throw new Error("TTS音声加工を中止しました。");
    }
    return sound;
  }

  const processor = NativeModules.BittyTtsEffects as TtsEffectsModule | undefined;
  if (!processor) {
    throw new Error("TTS音声エフェクトがありません。アプリを再ビルドしてください。");
  }
  const requestId = `${Date.now()}-${++nextRequestId}`;
  const cancel = () => { void processor.cancel(requestId).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let processedUri: string;
  try {
    processedUri = await processor.process(uri, effect, requestId);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (signal?.aborted) {
    await processor.remove(processedUri).catch(() => {});
    throw new Error("TTS音声加工を中止しました。");
  }
  try {
    const { sound } = await Audio.Sound.createAsync({ uri: processedUri }, status);
    const unload = sound.unloadAsync.bind(sound);
    sound.unloadAsync = async () => {
      try {
        return await unload();
      } finally {
        await processor.remove(processedUri).catch(() => {});
      }
    };
    if (signal?.aborted) {
      await sound.unloadAsync().catch(() => {});
      throw new Error("TTS音声加工を中止しました。");
    }
    return sound;
  } catch (error) {
    await processor.remove(processedUri).catch(() => {});
    throw error;
  }
}
