import {
  evaluateAutoBargeDetection,
  type AutoBargeDetectorState,
} from "../autoBargeDetector";

function assertEquals(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`[selftest] ${name}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

type SequenceCase = {
  name: string;
  samples: number[];
  isPlaybackActive: boolean;
  autoBargeInEnabled: boolean;
  autoAirPodsInput: boolean;
  expectedStart: boolean;
};

function runSequence(testCase: SequenceCase) {
  let state: AutoBargeDetectorState = {
    noiseFloorDb: -80,
    aboveSinceMs: 0,
    gapSinceMs: 0,
  };
  let shouldStart = false;
  for (let i = 0; i < testCase.samples.length; i += 1) {
    const res = evaluateAutoBargeDetection({
      nowMs: i * 100,
      meteringDb: testCase.samples[i],
      speechStarted: false,
      isPlaybackActive: testCase.isPlaybackActive,
      autoBargeInEnabled: testCase.autoBargeInEnabled,
      autoAirPodsInput: testCase.autoAirPodsInput,
      state,
    });
    state = res.nextState;
    if (res.shouldStart) {
      shouldStart = true;
      break;
    }
  }
  assertEquals(`${testCase.name}/start`, shouldStart, testCase.expectedStart);
  process.stdout.write(`ok ${testCase.name}\n`);
}

function run() {
  runSequence({
    name: "airpods_tts_noise_no_start",
    samples: [-83, -82, -76, -82, -70, -83, -80, -79, -81, -82],
    isPlaybackActive: true,
    autoBargeInEnabled: true,
    autoAirPodsInput: true,
    expectedStart: false,
  });

  runSequence({
    name: "airpods_tts_voice_with_dips_start",
    samples: [-82, -76, -66, -64, -69, -63, -62, -64, -61],
    isPlaybackActive: true,
    autoBargeInEnabled: true,
    autoAirPodsInput: true,
    expectedStart: true,
  });

  runSequence({
    name: "speaker_tts_spike_no_start",
    samples: [-82, -30, -82, -82, -31, -82, -82, -30],
    isPlaybackActive: true,
    autoBargeInEnabled: true,
    autoAirPodsInput: false,
    expectedStart: false,
  });

  runSequence({
    name: "non_tts_normal_voice_start",
    samples: [-55, -45, -36, -34, -33, -32],
    isPlaybackActive: false,
    autoBargeInEnabled: true,
    autoAirPodsInput: false,
    expectedStart: true,
  });
}

run();
