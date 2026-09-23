import { useEffect, useRef, type MutableRefObject } from "react";
import { deactivateKeepAwake } from "expo-keep-awake";
import type { IosFaceTrackingSession } from "../../faceTracking/iosFaceTrackingClient";
import type { StreamTtsControlState } from "../types/appTypes";

type Options = {
  conversationKeepAwakeTag: string;
  clearPendingApprovals: () => void;
  hideChatBottomToast: () => void;
  autoClientLogs: { clearFlushTimer: () => void };
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  faceTrackingSessionRef: MutableRefObject<IosFaceTrackingSession | null>;
  clearTtsPlaybackWatchdogTimer: () => void;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
};

export function useAppUnmountCleanupController(options: Options) {
  const latestRef = useRef(options);
  latestRef.current = options;
  useEffect(() => () => {
    const options = latestRef.current;
    options.clearPendingApprovals();
    options.hideChatBottomToast();
    deactivateKeepAwake(options.conversationKeepAwakeTag);
    options.autoClientLogs.clearFlushTimer();
    options.streamSocketRef.current?.close();
    options.streamSocketRef.current = null;
    options.streamTtsControlRef.current?.cleanup();
    options.streamTtsControlRef.current = null;
    const faceTrackingSession = options.faceTrackingSessionRef.current;
    options.faceTrackingSessionRef.current = null;
    if (faceTrackingSession) void faceTrackingSession.stop().catch(() => {});
    options.clearTtsPlaybackWatchdogTimer();
    options.ttsPlaybackWantedRef.current = false;
    options.ttsPlaybackTransitionInFlightRef.current = false;
    options.ttsStopInFlightRef.current = null;
  }, []);
}
