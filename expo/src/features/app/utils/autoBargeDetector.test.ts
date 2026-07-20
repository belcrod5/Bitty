import {
  evaluateAutoBargeDetection,
  type AutoBargeDetectorInput,
  type AutoBargeDetectorState,
} from "./autoBargeDetector";

type SequenceCase = Pick<
  AutoBargeDetectorInput,
  "isPlaybackActive" | "autoBargeInEnabled" | "autoAirPodsInput"
> & {
  samples: number[];
};

function runSequence(testCase: SequenceCase) {
  let state: AutoBargeDetectorState = {
    noiseFloorDb: -80,
    aboveSinceMs: 0,
    gapSinceMs: 0,
  };
  let shouldStart = false;

  testCase.samples.forEach((meteringDb, index) => {
    const result = evaluateAutoBargeDetection({
      nowMs: index * 100,
      meteringDb,
      speechStarted: false,
      isPlaybackActive: testCase.isPlaybackActive,
      autoBargeInEnabled: testCase.autoBargeInEnabled,
      autoAirPodsInput: testCase.autoAirPodsInput,
      state,
    });
    state = result.nextState;
    shouldStart ||= result.shouldStart;
  });

  return shouldStart;
}

describe("evaluateAutoBargeDetection", () => {
  it("starts for normal voice below the former production threshold", () => {
    expect(runSequence({
      samples: [-55, -45, -36, -34, -33, -32],
      isPlaybackActive: false,
      autoBargeInEnabled: true,
      autoAirPodsInput: false,
    })).toBe(true);
  });

  it("does not start for an isolated spike", () => {
    expect(runSequence({
      samples: [-70, -32, -70, -70, -70],
      isPlaybackActive: false,
      autoBargeInEnabled: true,
      autoAirPodsInput: false,
    })).toBe(false);
  });

  it("does not start for AirPods playback noise", () => {
    expect(runSequence({
      samples: [-83, -82, -76, -82, -70, -83, -80, -79, -81, -82],
      isPlaybackActive: true,
      autoBargeInEnabled: true,
      autoAirPodsInput: true,
    })).toBe(false);
  });

  it("starts for AirPods voice during playback despite short dips", () => {
    expect(runSequence({
      samples: [-82, -76, -66, -64, -69, -63, -62, -64, -61],
      isPlaybackActive: true,
      autoBargeInEnabled: true,
      autoAirPodsInput: true,
    })).toBe(true);
  });

  it("does not start for speaker playback spikes", () => {
    expect(runSequence({
      samples: [-82, -30, -82, -82, -31, -82, -82, -30],
      isPlaybackActive: true,
      autoBargeInEnabled: true,
      autoAirPodsInput: false,
    })).toBe(false);
  });

  it("returns new state without mutating its input", () => {
    const state = Object.freeze<AutoBargeDetectorState>({
      noiseFloorDb: -80,
      aboveSinceMs: 0,
      gapSinceMs: 0,
    });

    const result = evaluateAutoBargeDetection({
      nowMs: 100,
      meteringDb: -34,
      speechStarted: false,
      isPlaybackActive: false,
      autoBargeInEnabled: true,
      autoAirPodsInput: false,
      state,
    });

    expect(state).toEqual({ noiseFloorDb: -80, aboveSinceMs: 0, gapSinceMs: 0 });
    expect(result.nextState).not.toBe(state);
  });
});
