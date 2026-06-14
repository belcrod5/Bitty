import { useCallback, type MutableRefObject } from "react";
import type { IosFaceTrackingState } from "../../faceTracking/iosFaceTrackingClient";

type UseFaceTrackingStateControllerOptions = {
  autoFaceTrackingAllowCacheMs: number;
  faceTrackingEnabledRef: MutableRefObject<boolean>;
  faceTrackingLookingRef: MutableRefObject<boolean>;
  faceTrackingFaceDetectedRef: MutableRefObject<boolean>;
  faceTrackingAllowCachedAtRef: MutableRefObject<number>;
  faceTrackingAllowCachedValueRef: MutableRefObject<boolean>;
  faceTrackingSuppressedRef: MutableRefObject<boolean>;
  faceTrackingSuppressLogAtRef: MutableRefObject<number>;
  faceTrackingNotLookingSinceRef: MutableRefObject<number>;
  setFaceTrackingEnabled: (value: boolean) => void;
  setFaceTrackingLooking: (value: boolean) => void;
  setFaceTrackingFaceDetected: (value: boolean) => void;
  setFaceTrackingRunning: (value: boolean) => void;
  setFaceTrackingYawDeg: (value: number) => void;
  setFaceTrackingPitchDeg: (value: number) => void;
  setFaceTrackingLookScore: (value: number) => void;
};

export function useFaceTrackingStateController(options: UseFaceTrackingStateControllerOptions) {
  const {
    autoFaceTrackingAllowCacheMs,
    faceTrackingEnabledRef,
    faceTrackingLookingRef,
    faceTrackingFaceDetectedRef,
    faceTrackingAllowCachedAtRef,
    faceTrackingAllowCachedValueRef,
    faceTrackingSuppressedRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingNotLookingSinceRef,
    setFaceTrackingEnabled,
    setFaceTrackingLooking,
    setFaceTrackingFaceDetected,
    setFaceTrackingRunning,
    setFaceTrackingYawDeg,
    setFaceTrackingPitchDeg,
    setFaceTrackingLookScore,
  } = options;

  const setFaceTrackingEnabledWithRef = useCallback((enabled: boolean) => {
    faceTrackingEnabledRef.current = enabled;
    setFaceTrackingEnabled(enabled);
    faceTrackingAllowCachedAtRef.current = 0;
    faceTrackingAllowCachedValueRef.current = !enabled || faceTrackingLookingRef.current;
    if (!enabled) {
      faceTrackingLookingRef.current = true;
      faceTrackingFaceDetectedRef.current = false;
      setFaceTrackingLooking(true);
      setFaceTrackingFaceDetected(false);
      setFaceTrackingRunning(false);
      setFaceTrackingYawDeg(0);
      setFaceTrackingPitchDeg(0);
      setFaceTrackingLookScore(0);
      faceTrackingSuppressedRef.current = false;
      faceTrackingSuppressLogAtRef.current = 0;
      faceTrackingNotLookingSinceRef.current = 0;
    }
  }, [
    faceTrackingAllowCachedAtRef,
    faceTrackingAllowCachedValueRef,
    faceTrackingEnabledRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    faceTrackingNotLookingSinceRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    setFaceTrackingEnabled,
    setFaceTrackingFaceDetected,
    setFaceTrackingLookScore,
    setFaceTrackingLooking,
    setFaceTrackingPitchDeg,
    setFaceTrackingRunning,
    setFaceTrackingYawDeg,
  ]);

  const applyFaceTrackingState = useCallback((state: IosFaceTrackingState) => {
    const isLooking = Boolean(state.isLooking);
    const faceDetected = Boolean(state.faceDetected);
    faceTrackingLookingRef.current = isLooking;
    faceTrackingFaceDetectedRef.current = faceDetected;
    faceTrackingAllowCachedAtRef.current = Date.now();
    faceTrackingAllowCachedValueRef.current = !faceTrackingEnabledRef.current || isLooking;
    setFaceTrackingLooking(isLooking);
    setFaceTrackingRunning(Boolean(state.isRunning));
    setFaceTrackingFaceDetected(faceDetected);
    setFaceTrackingYawDeg(Number(state.yawDeg || 0));
    setFaceTrackingPitchDeg(Number(state.pitchDeg || 0));
    setFaceTrackingLookScore(Number(state.lookScore || 0));
  }, [
    faceTrackingAllowCachedAtRef,
    faceTrackingAllowCachedValueRef,
    faceTrackingEnabledRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    setFaceTrackingFaceDetected,
    setFaceTrackingLookScore,
    setFaceTrackingLooking,
    setFaceTrackingPitchDeg,
    setFaceTrackingRunning,
    setFaceTrackingYawDeg,
  ]);

  const faceTrackingAllowsStt = useCallback((forceFresh = false) => {
    const now = Date.now();
    if (
      !forceFresh &&
      faceTrackingAllowCachedAtRef.current > 0 &&
      now - faceTrackingAllowCachedAtRef.current < autoFaceTrackingAllowCacheMs
    ) {
      return faceTrackingAllowCachedValueRef.current;
    }
    const allowed = !faceTrackingEnabledRef.current || faceTrackingLookingRef.current;
    faceTrackingAllowCachedAtRef.current = now;
    faceTrackingAllowCachedValueRef.current = allowed;
    return allowed;
  }, [
    autoFaceTrackingAllowCacheMs,
    faceTrackingAllowCachedAtRef,
    faceTrackingAllowCachedValueRef,
    faceTrackingEnabledRef,
    faceTrackingLookingRef,
  ]);

  return {
    setFaceTrackingEnabledWithRef,
    applyFaceTrackingState,
    faceTrackingAllowsStt,
  };
}
