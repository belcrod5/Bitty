import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceConversationPlayback } from "../screens/VoiceConversationScreen";
import type { VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { DEFAULT_TTS_PROVIDER } from "../utils/audioConfig";

type Speech = { id: string; text: string; owner: VoiceOrchestrator };

// Synthesis installs a stream; its Promise is not the audio completion signal.
// Wait for the shared player to become idle before starting the next speaker.
export function useConsultationSpeech(roomId: string, playback?: VoiceConversationPlayback) {
  const [queue, setQueue] = useState<(Speech & { roomId: string })[]>([]);
  const [active, setActive] = useState<(Speech & { settled: boolean; audioId: string }) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const epoch = useRef(0);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [error, setError] = useState("");
  const stop = useCallback(() => {
    epoch.current += 1;
    const current = activeRef.current;
    activeRef.current = null; setActive(null); setQueue([]);
    if (current) void playbackRef.current?.stopTtsPlayback({ interruptStream: true,
      expectedMessageId: current.audioId, reason: "consultation_speech_stopped" }).catch(() => {})
      .finally(() => setPlayerRevision((value) => value + 1));
  }, []);
  useEffect(() => { setError(""); return stop; }, [roomId, stop]);
  const busy = Boolean(playback?.isTtsPlaybackActive || playback?.isTtsPlaying
    || playback && ["queued", "synthesizing", "playing"].includes(playback.ttsUiStatus));
  useEffect(() => {
    if (!playback || !roomId || active || busy || playback.getPlaybackState?.().active || !queue.length || queue[0].roomId !== roomId) return;
    const speech = queue[0], token = epoch.current;
    const audioId = `consultation:${roomId}:${speech.id}:${randomUUID()}`;
    setQueue((current) => current.slice(1));
    activeRef.current = { ...speech, settled: false, audioId }; setActive(activeRef.current); setError("");
    void playback.synthesizeSpeechStream(speech.text, { scope: "voice", orchestratorId: speech.owner.id,
      messageId: audioId, ttsProvider: speech.owner.ttsProvider || DEFAULT_TTS_PROVIDER, voiceId: speech.owner.voiceId || "" })
      .catch(() => { if (epoch.current === token) setError("音声再生に失敗しました。"); })
      .finally(() => {
        if (epoch.current !== token) {
          void playback.stopTtsPlayback({ interruptStream: true, expectedMessageId: audioId,
            reason: "consultation_speech_stale" }).catch(() => {}); return;
        }
        setActive((current) => current?.audioId === audioId ? { ...current, settled: true } : current);
      });
  }, [active, busy, playback, queue, roomId, playerRevision]);
  useEffect(() => {
    if (!active?.settled) return;
    // Another surface has taken the player. Do not cancel its audio.
    const state = playback?.getPlaybackState?.();
    const messageId = state?.messageId;
    if (messageId && messageId !== active.audioId) {
      activeRef.current = null; setActive(null); return;
    }
    if (playback?.ttsUiStatus === "error") {
      setError("音声再生に失敗しました。");
      void playback.stopTtsPlayback({ interruptStream: true, expectedMessageId: active.audioId,
        reason: "consultation_speech_failed" }).catch(() => {})
        .finally(() => setPlayerRevision((value) => value + 1));
      activeRef.current = null; setActive(null);
    } else if (!(state?.active ?? busy)) { activeRef.current = null; setActive(null); }
  }, [active, busy, playback]);
  const enqueue = useCallback((speech: Speech) => {
    if (!playbackRef.current || !roomId || !speech.text.trim()) return;
    setQueue((current) => current.some((item) => item.id === speech.id) || activeRef.current?.id === speech.id ? current : [...current, { ...speech, roomId }]);
  }, [roomId]);
  const read = useCallback((speech: Speech) => { stop(); enqueue(speech); }, [enqueue, stop]);
  return { enqueue, read, stop, error, activeMessageId: active?.id || "", pending: Boolean(active || queue.length) };
}
