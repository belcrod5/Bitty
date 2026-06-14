import { useCallback } from "react";
import { Audio } from "expo-av";

export function useRecordingDeviceController() {
  const ensureMicReady = useCallback(async () => {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("マイクの権限が許可されていません。");
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
  }, []);

  const releaseRecording = useCallback(async (rec: Audio.Recording) => {
    let status: Awaited<ReturnType<Audio.Recording["getStatusAsync"]>> | null = null;
    try {
      status = await rec.getStatusAsync();
    } catch {}

    const shouldAttemptStop =
      !status ||
      !!status.isRecording ||
      !!status.canRecord ||
      !status.isDoneRecording;
    if (shouldAttemptStop) {
      try {
        await rec.stopAndUnloadAsync();
      } catch {}
      try {
        status = await rec.getStatusAsync();
      } catch {}
    }
    return status;
  }, []);

  return {
    ensureMicReady,
    releaseRecording,
  };
}
