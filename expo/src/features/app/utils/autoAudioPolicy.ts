type AutoTtsCapturePolicy = {
  autoBargeInEnabled: boolean;
  autoSpeakerPriorityEnabled: boolean;
};

export function shouldAllowAutoCaptureDuringTts(
  policy: AutoTtsCapturePolicy,
): boolean {
  return policy.autoBargeInEnabled && !policy.autoSpeakerPriorityEnabled;
}
