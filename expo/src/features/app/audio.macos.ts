import { Image, NativeEventEmitter, NativeModules } from "react-native";
import type {
  Audio as ExpoAudio,
  AudioMode,
  AVPlaybackStatus,
  AVPlaybackStatusToSet,
  ResizeMode as ExpoResizeMode,
  VideoProps,
} from "expo-av";

type PlaybackSource = number | { uri?: string };
type PlaybackStatusHandler = ((status: AVPlaybackStatus) => void) | null;

type NativeAudioModule = {
  create(uri: string, initialStatus: AVPlaybackStatusToSet): Promise<{
    soundId: string;
    status: AVPlaybackStatus;
  }>;
  getStatus(soundId: string): Promise<AVPlaybackStatus>;
  setStatus(soundId: string, status: AVPlaybackStatusToSet): Promise<AVPlaybackStatus>;
  play(soundId: string): Promise<AVPlaybackStatus>;
  playFromPosition(soundId: string, positionMillis: number): Promise<AVPlaybackStatus>;
  stop(soundId: string): Promise<AVPlaybackStatus>;
  unload(soundId: string): Promise<AVPlaybackStatus>;
};

type PlaybackStatusEvent = {
  soundId?: string;
  status?: AVPlaybackStatus;
};

const nativeAudio = NativeModules.BittyAudio as NativeAudioModule | undefined;
const sounds = new Map<string, MacOSSound>();

if (nativeAudio) {
  const emitter = new NativeEventEmitter(nativeAudio as never);
  emitter.addListener("BittyAudioPlaybackStatus", (event: PlaybackStatusEvent) => {
    const soundId = String(event?.soundId || "");
    if (soundId && event?.status) {
      sounds.get(soundId)?.receiveStatus(event.status);
    }
  });
}

function requireNativeAudio(): NativeAudioModule {
  if (!nativeAudio) {
    throw new Error("Mac音声再生モジュールがありません。macOSアプリを再ビルドしてください。");
  }
  return nativeAudio;
}

function resolveSourceUri(source: PlaybackSource): string {
  const uri = typeof source === "number"
    ? Image.resolveAssetSource(source)?.uri
    : source?.uri;
  const normalized = String(uri || "").trim();
  if (!normalized) {
    throw new Error("音声URLが空です。");
  }
  return normalized;
}

class MacOSSound {
  private statusHandler: PlaybackStatusHandler = null;

  private constructor(
    private readonly soundId: string,
    private status: AVPlaybackStatus
  ) {}

  static async createAsync(
    source: PlaybackSource,
    initialStatus: AVPlaybackStatusToSet = {}
  ): Promise<{ sound: MacOSSound; status: AVPlaybackStatus }> {
    const result = await requireNativeAudio().create(resolveSourceUri(source), initialStatus);
    const sound = new MacOSSound(result.soundId, result.status);
    sounds.set(result.soundId, sound);
    return { sound, status: result.status };
  }

  receiveStatus(status: AVPlaybackStatus) {
    this.status = status;
    this.statusHandler?.(status);
  }

  setOnPlaybackStatusUpdate(handler: PlaybackStatusHandler) {
    this.statusHandler = handler;
    handler?.(this.status);
  }

  async getStatusAsync() {
    return this.acceptStatus(await requireNativeAudio().getStatus(this.soundId));
  }

  async setStatusAsync(status: AVPlaybackStatusToSet) {
    return this.acceptStatus(await requireNativeAudio().setStatus(this.soundId, status));
  }

  async playAsync() {
    return this.acceptStatus(await requireNativeAudio().play(this.soundId));
  }

  async playFromPositionAsync(positionMillis: number) {
    return this.acceptStatus(
      await requireNativeAudio().playFromPosition(this.soundId, positionMillis)
    );
  }

  async replayAsync() {
    return this.playFromPositionAsync(0);
  }

  async setIsLoopingAsync(isLooping: boolean) {
    return this.setStatusAsync({ isLooping });
  }

  async stopAsync() {
    return this.acceptStatus(await requireNativeAudio().stop(this.soundId));
  }

  async unloadAsync() {
    try {
      return this.acceptStatus(await requireNativeAudio().unload(this.soundId));
    } finally {
      sounds.delete(this.soundId);
      this.statusHandler = null;
    }
  }

  private acceptStatus(status: AVPlaybackStatus) {
    this.receiveStatus(status);
    return status;
  }
}

class UnsupportedRecording {
  constructor() {
    throw new Error("録音機能はMacでは利用できません。");
  }
}

export class Audio {
  static Recording = UnsupportedRecording as unknown as { new(): ExpoAudio.Recording };
  static RecordingOptionsPresets: { HIGH_QUALITY: ExpoAudio.RecordingOptions } = {
    HIGH_QUALITY: {} as ExpoAudio.RecordingOptions,
  };
  static Sound = MacOSSound;

  static async requestPermissionsAsync() {
    return { granted: false };
  }

  static async setAudioModeAsync(_mode: Partial<AudioMode>) {}
}

export namespace Audio {
  export type Sound = MacOSSound;
  export type Recording = ExpoAudio.Recording;
  export type RecordingOptions = ExpoAudio.RecordingOptions;
  export type RecordingStatus = ExpoAudio.RecordingStatus;
}

export const supportsAudioRecording = false;

export const ResizeMode = { CONTAIN: "contain" as ExpoResizeMode } as const;

export function Video(_props: VideoProps) {
  return null;
}
