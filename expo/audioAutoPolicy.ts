export type AutoAudioPolicyState = {
  autoRecordingEnabled: boolean;
  autoBargeInEnabled: boolean;
  autoSpeakerPriorityEnabled: boolean;
  autoAirPodsInput: boolean;
  ttsPlaying: boolean;
  replyLoading: boolean;
};

export function shouldWaitForReplyOnly(state: AutoAudioPolicyState): boolean {
  return state.replyLoading && !state.ttsPlaying && !state.autoBargeInEnabled;
}

export function shouldBlockCaptureWhilePlayback(state: AutoAudioPolicyState): boolean {
  if (!state.ttsPlaying) return false;
  if (state.autoAirPodsInput) return false;
  if (state.autoBargeInEnabled) return false;
  return true;
}

export function shouldFinalizeAutoCaptureForTtsPlayback(state: AutoAudioPolicyState): boolean {
  return (
    state.autoRecordingEnabled &&
    !state.autoBargeInEnabled &&
    state.autoSpeakerPriorityEnabled &&
    !state.autoAirPodsInput
  );
}

export function shouldKeepRecordingEnabledInAudioMode(state: AutoAudioPolicyState): boolean {
  return state.autoRecordingEnabled;
}
