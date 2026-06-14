import {
  shouldBlockCaptureWhilePlayback,
  shouldFinalizeAutoCaptureForTtsPlayback,
  shouldKeepRecordingEnabledInAudioMode,
  shouldWaitForReplyOnly,
  type AutoAudioPolicyState,
} from "../audioAutoPolicy";

function assertEquals(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`[selftest] ${name}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function runCase(name: string, state: AutoAudioPolicyState, expected: {
  waitReplyOnly: boolean;
  blockPlayback: boolean;
  finalizeForTts: boolean;
  keepRecording: boolean;
}) {
  assertEquals(`${name}/waitReplyOnly`, shouldWaitForReplyOnly(state), expected.waitReplyOnly);
  assertEquals(`${name}/blockPlayback`, shouldBlockCaptureWhilePlayback(state), expected.blockPlayback);
  assertEquals(`${name}/finalizeForTts`, shouldFinalizeAutoCaptureForTtsPlayback(state), expected.finalizeForTts);
  assertEquals(`${name}/keepRecording`, shouldKeepRecordingEnabledInAudioMode(state), expected.keepRecording);
  process.stdout.write(`ok ${name}\n`);
}

function run() {
  runCase(
    "barge-in_on_speaker_priority_on_tts_playing",
    {
      autoRecordingEnabled: true,
      autoBargeInEnabled: true,
      autoSpeakerPriorityEnabled: true,
      autoAirPodsInput: false,
      ttsPlaying: true,
      replyLoading: true,
    },
    {
      waitReplyOnly: false,
      blockPlayback: false,
      finalizeForTts: false,
      keepRecording: true,
    }
  );

  runCase(
    "barge-in_off_speaker_priority_on_tts_playing",
    {
      autoRecordingEnabled: true,
      autoBargeInEnabled: false,
      autoSpeakerPriorityEnabled: true,
      autoAirPodsInput: false,
      ttsPlaying: true,
      replyLoading: false,
    },
    {
      waitReplyOnly: false,
      blockPlayback: true,
      finalizeForTts: true,
      keepRecording: true,
    }
  );

  runCase(
    "reply_only_no_wait_when_barge_in_on",
    {
      autoRecordingEnabled: true,
      autoBargeInEnabled: true,
      autoSpeakerPriorityEnabled: true,
      autoAirPodsInput: false,
      ttsPlaying: false,
      replyLoading: true,
    },
    {
      waitReplyOnly: false,
      blockPlayback: false,
      finalizeForTts: false,
      keepRecording: true,
    }
  );

  runCase(
    "reply_only_wait_when_barge_in_off",
    {
      autoRecordingEnabled: true,
      autoBargeInEnabled: false,
      autoSpeakerPriorityEnabled: true,
      autoAirPodsInput: false,
      ttsPlaying: false,
      replyLoading: true,
    },
    {
      waitReplyOnly: true,
      blockPlayback: false,
      finalizeForTts: true,
      keepRecording: true,
    }
  );

  runCase(
    "auto_recording_off",
    {
      autoRecordingEnabled: false,
      autoBargeInEnabled: true,
      autoSpeakerPriorityEnabled: true,
      autoAirPodsInput: true,
      ttsPlaying: true,
      replyLoading: false,
    },
    {
      waitReplyOnly: false,
      blockPlayback: false,
      finalizeForTts: false,
      keepRecording: false,
    }
  );
}

run();
