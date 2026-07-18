import { shouldAllowAutoCaptureDuringTts } from "./autoAudioPolicy";

describe("shouldAllowAutoCaptureDuringTts", () => {
  it.each([
    [true, true, false],
    [true, false, true],
    [false, true, false],
    [false, false, false],
  ])(
    "bargeIn=%s playbackPriority=%s returns %s",
    (autoBargeInEnabled, autoSpeakerPriorityEnabled, expected) => {
      expect(shouldAllowAutoCaptureDuringTts({
        autoBargeInEnabled,
        autoSpeakerPriorityEnabled,
      })).toBe(expected);
    },
  );
});
