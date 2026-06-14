import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export type IosFaceTrackingState = {
  available: boolean;
  isRunning: boolean;
  faceDetected: boolean;
  isLooking: boolean;
  yawDeg: number;
  pitchDeg: number;
  lookScore: number;
  updatedAtMs: number;
};

type FaceTrackingNativeModule = {
  start: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: () => Promise<Record<string, unknown>>;
  getState: () => Promise<Record<string, unknown>>;
};

type NativeFaceTrackingPayload = Record<string, unknown>;

const faceTrackingNativeModule: FaceTrackingNativeModule | null = (
  Platform.OS === "ios"
    ? ((NativeModules.FaceTrackingModule as FaceTrackingNativeModule | undefined) || null)
    : null
);

const DEFAULT_STATE: IosFaceTrackingState = {
  available: false,
  isRunning: false,
  faceDetected: false,
  isLooking: false,
  yawDeg: 0,
  pitchDeg: 0,
  lookScore: 0.5,
  updatedAtMs: 0,
};

function toFiniteNumber(raw: unknown, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeFaceTrackingState(raw: unknown): IosFaceTrackingState {
  const payload: NativeFaceTrackingPayload = raw && typeof raw === "object"
    ? (raw as NativeFaceTrackingPayload)
    : {};
  const now = Date.now();
  return {
    available: Boolean(payload.available),
    isRunning: Boolean(payload.isRunning),
    faceDetected: Boolean(payload.faceDetected),
    isLooking: Boolean(payload.isLooking),
    yawDeg: toFiniteNumber(payload.yawDeg, 0),
    pitchDeg: toFiniteNumber(payload.pitchDeg, 0),
    lookScore: toFiniteNumber(payload.lookScore, DEFAULT_STATE.lookScore),
    updatedAtMs: Math.max(0, Math.floor(toFiniteNumber(payload.updatedAtMs, now))),
  };
}

function errorMessageFromPayload(raw: unknown) {
  const payload: NativeFaceTrackingPayload = raw && typeof raw === "object"
    ? (raw as NativeFaceTrackingPayload)
    : {};
  const message = String(payload.message || payload.error || "face tracking failed").trim();
  return message || "face tracking failed";
}

export type StartIosFaceTrackingOptions = {
  onState?: (state: IosFaceTrackingState) => void;
  onError?: (error: Error) => void;
};

export type IosFaceTrackingSession = {
  stop: () => Promise<void>;
  getState: () => Promise<IosFaceTrackingState>;
};

export function isIosFaceTrackingAvailable() {
  return Platform.OS === "ios" && !!faceTrackingNativeModule;
}

export async function startIosFaceTrackingSession(
  options: StartIosFaceTrackingOptions = {}
): Promise<IosFaceTrackingSession> {
  if (!faceTrackingNativeModule) {
    throw new Error("iOS face tracking module is unavailable. Rebuild iOS app with FaceTrackingModule.");
  }

  const emitter = new NativeEventEmitter(faceTrackingNativeModule as never);
  const onState = options.onState;
  const onError = options.onError;

  const stateSubscription = emitter.addListener("onFaceTrackingStateChanged", (event: unknown) => {
    onState?.(normalizeFaceTrackingState(event));
  });

  const errorSubscription = emitter.addListener("onFaceTrackingError", (event: unknown) => {
    onError?.(new Error(errorMessageFromPayload(event)));
  });

  let stopped = false;

  const stopSession = async () => {
    if (stopped) return;
    stopped = true;
    stateSubscription.remove();
    errorSubscription.remove();
    await faceTrackingNativeModule.stop().catch(() => {});
  };

  try {
    const startedState = await faceTrackingNativeModule.start({
      enterYawDeg: 30,
      enterPitchDeg: 30,
      exitYawDeg: 38,
      exitPitchDeg: 38,
      lookInScore: 0.62,
      lookOutScore: 0.38,
      scoreRiseStep: 0.35,
      scoreFallStep: 0.25,
      noFaceGraceMs: 400,
      minEmitIntervalMs: 120,
    });
    onState?.(normalizeFaceTrackingState(startedState));
  } catch (error) {
    await stopSession();
    throw error;
  }

  return {
    stop: stopSession,
    getState: async () => {
      if (!faceTrackingNativeModule) return DEFAULT_STATE;
      const raw = await faceTrackingNativeModule.getState();
      return normalizeFaceTrackingState(raw);
    },
  };
}
