import { useEffect, useRef } from "react";
import { useRunnerWebSocketManager } from "../runnerWs/RunnerWebSocketContext";
import { getVoiceControl, type VoiceTarget } from "./voiceControl";

// Register the conversation owner, outside transient microphone/composer children.
export function useChatControlSurface(target: VoiceTarget | null, panelId?: string) {
  const control = getVoiceControl(useRunnerWebSocketManager());
  const id = useRef(`chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).current;
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => control.registerChat({ id, panelId, target: () => latest.current }), [control, id, panelId]);
}
