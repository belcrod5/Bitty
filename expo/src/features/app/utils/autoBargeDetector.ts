export type AutoBargeDetectorState = {
  noiseFloorDb: number;
  aboveSinceMs: number;
  gapSinceMs: number;
};

export type AutoBargeDetectorInput = {
  nowMs: number;
  meteringDb: number;
  speechStarted: boolean;
  isPlaybackActive: boolean;
  autoBargeInEnabled: boolean;
  autoAirPodsInput: boolean;
  state: AutoBargeDetectorState;
};

export type AutoBargeDetectorOptions = {
  baseStartThresholdDb: number;
  baseStopThresholdDb: number;
  bargeOffsetDb: number;
  strictHoldMs: number;
  baseHoldMs: number;
  airPodsHoldMs: number;
  airPodsMinStartDb: number;
  airPodsMarginDb: number;
  dynamicStopOffsetDb: number;
  noiseAlphaIdle: number;
  noiseAlphaPlayback: number;
  gapGraceMs: number;
  airPodsGapGraceMs: number;
};

export type AutoBargeDetectorOutput = {
  nextState: AutoBargeDetectorState;
  playbackBargeEnabled: boolean;
  strictBargeFilter: boolean;
  startThresholdDb: number;
  stopThresholdDb: number;
  startHoldMs: number;
  aboveForMs: number;
  shouldStart: boolean;
};

export const AUTO_BARGE_BASE_START_THRESHOLD_DB = -35;

const DEFAULT_OPTIONS: AutoBargeDetectorOptions = {
  baseStartThresholdDb: AUTO_BARGE_BASE_START_THRESHOLD_DB,
  baseStopThresholdDb: -45,
  bargeOffsetDb: 6,
  strictHoldMs: 350,
  baseHoldMs: 200,
  airPodsHoldMs: 120,
  airPodsMinStartDb: -68,
  airPodsMarginDb: 10,
  dynamicStopOffsetDb: 8,
  noiseAlphaIdle: 0.18,
  noiseAlphaPlayback: 0.1,
  gapGraceMs: 120,
  airPodsGapGraceMs: 260,
};

function sanitizeState(state: AutoBargeDetectorState): AutoBargeDetectorState {
  const noiseFloorDb = Number.isFinite(state.noiseFloorDb) ? state.noiseFloorDb : -80;
  const aboveSinceMs = Number.isFinite(state.aboveSinceMs) ? Math.max(0, state.aboveSinceMs) : 0;
  const gapSinceMs = Number.isFinite(state.gapSinceMs) ? Math.max(0, state.gapSinceMs) : 0;
  return {
    noiseFloorDb,
    aboveSinceMs,
    gapSinceMs,
  };
}

export function evaluateAutoBargeDetection(
  input: AutoBargeDetectorInput,
  options?: Partial<AutoBargeDetectorOptions>
): AutoBargeDetectorOutput {
  const cfg: AutoBargeDetectorOptions = {
    ...DEFAULT_OPTIONS,
    ...(options || {}),
  };
  const nowMs = Number(input.nowMs || 0);
  const meteringDb = Number.isFinite(input.meteringDb) ? input.meteringDb : -160;
  const speechStarted = Boolean(input.speechStarted);
  const playbackBargeEnabled = Boolean(input.isPlaybackActive && input.autoBargeInEnabled);
  const strictBargeFilter = Boolean(playbackBargeEnabled && !input.autoAirPodsInput);
  const sanitized = sanitizeState(input.state);

  let noiseFloorDb = sanitized.noiseFloorDb;
  let aboveSinceMs = sanitized.aboveSinceMs;
  let gapSinceMs = sanitized.gapSinceMs;

  if (!speechStarted) {
    const alpha = playbackBargeEnabled ? cfg.noiseAlphaPlayback : cfg.noiseAlphaIdle;
    const cappedMeter = Math.min(meteringDb, noiseFloorDb + 1.5);
    noiseFloorDb = noiseFloorDb + (cappedMeter - noiseFloorDb) * alpha;
  }

  const baseStartThresholdDb = strictBargeFilter
    ? cfg.baseStartThresholdDb + cfg.bargeOffsetDb
    : cfg.baseStartThresholdDb;
  const airPodsAdaptiveStartDb = Math.max(
    cfg.airPodsMinStartDb,
    noiseFloorDb + cfg.airPodsMarginDb
  );
  const startThresholdDb = (
    playbackBargeEnabled && input.autoAirPodsInput
  ) ? airPodsAdaptiveStartDb : baseStartThresholdDb;
  const stopThresholdDb = Math.min(
    cfg.baseStopThresholdDb,
    startThresholdDb - cfg.dynamicStopOffsetDb
  );
  const startHoldMs = (
    playbackBargeEnabled && input.autoAirPodsInput
  ) ? cfg.airPodsHoldMs : (strictBargeFilter ? cfg.strictHoldMs : cfg.baseHoldMs);

  if (!speechStarted) {
    if (meteringDb >= startThresholdDb) {
      if (!aboveSinceMs) {
        aboveSinceMs = nowMs;
      }
      gapSinceMs = 0;
    } else if (aboveSinceMs > 0) {
      if (!gapSinceMs) {
        gapSinceMs = nowMs;
      }
      const graceMs = (
        playbackBargeEnabled && input.autoAirPodsInput
      ) ? cfg.airPodsGapGraceMs : cfg.gapGraceMs;
      if (nowMs - gapSinceMs > graceMs) {
        aboveSinceMs = 0;
        gapSinceMs = 0;
      }
    }
  }

  const aboveForMs = aboveSinceMs > 0 ? Math.max(0, nowMs - aboveSinceMs) : 0;
  const shouldStart = (
    !speechStarted &&
    meteringDb >= startThresholdDb &&
    aboveForMs >= startHoldMs
  );

  return {
    nextState: {
      noiseFloorDb,
      aboveSinceMs,
      gapSinceMs,
    },
    playbackBargeEnabled,
    strictBargeFilter,
    startThresholdDb,
    stopThresholdDb,
    startHoldMs,
    aboveForMs,
    shouldStart,
  };
}
