import { Audio } from "../app/audio";

const SOUNDS = {
  ready: require("../../../modules/bitty-stt-transport/ios/Resources/voice-input-ready.wav"),
  send: require("../../../assets/sfx/voice-input-send.wav"),
};

// Playback settles only after audio-session release, before the next capture starts.
export function playVoiceInputSound(key: keyof typeof SOUNDS, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let sound: Audio.Sound | undefined;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      const complete = () => { if (error) reject(error); else resolve(); };
      if (!sound) { complete(); return; }
      sound.setOnPlaybackStatusUpdate(null);
      const releaseTimer = setTimeout(() => reject(new Error("voice_input_sound_release_failed")), 2_000);
      void sound.unloadAsync().then(() => {
        clearTimeout(releaseTimer);
        complete();
      }, () => {
        clearTimeout(releaseTimer);
        reject(new Error("voice_input_sound_release_failed"));
      });
    };
    const cancelled = () => finish();
    const timer = setTimeout(() => finish(new Error("voice_input_sound_timeout")), 2_000);
    signal?.addEventListener("abort", cancelled, { once: true });
    void Audio.Sound.createAsync(SOUNDS[key], { shouldPlay: false, volume: 0.65 }).then(({ sound: loaded }) => {
      if (settled) {
        void loaded.unloadAsync().catch(() => undefined);
        return;
      }
      sound = loaded;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) {
          if (status.error) finish(new Error(status.error));
        } else if (status.didJustFinish) finish();
      });
      if (!settled) void sound.playAsync().catch(finish);
    }).catch(finish);
  });
}
