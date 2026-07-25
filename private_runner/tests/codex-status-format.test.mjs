import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";

const { buildCodexStatusFromWham } = (await import("../src/server-runtime.mjs")).__TESTING__;

function windowWith(seconds, usedPercent) {
  return {
    limit_window_seconds: seconds,
    used_percent: usedPercent,
    reset_at: 1_800_000_000,
  };
}

test("formats 5h and weekly windows by duration regardless of primary/secondary placement", () => {
  const result = buildCodexStatusFromWham({
    rate_limit: {
      primary_window: windowWith(7 * 24 * 60 * 60, 25),
      secondary_window: windowWith(5 * 60 * 60, 40),
    },
  });

  assert.deepEqual(result.limitLines.map(({ label }) => label), ["5h limit", "Weekly limit"]);
  assert.match(result.statusText, /5h limit:[^\n]*60% left/);
  assert.match(result.statusText, /Weekly limit:[^\n]*75% left/);
});

test("formats a weekly window when it is the only top-level window", () => {
  const result = buildCodexStatusFromWham({
    rate_limit: {
      primary_window: windowWith(7 * 24 * 60 * 60, 23),
      secondary_window: null,
    },
  });

  assert.deepEqual(result.limitLines.map(({ label }) => label), ["Weekly limit"]);
  assert.doesNotMatch(result.statusText, /5h limit:/);
  assert.match(result.statusText, /Weekly limit:[^\n]*77% left/);
});

test("formats a 5h window when it is the only top-level window", () => {
  const result = buildCodexStatusFromWham({
    rate_limit: {
      primary_window: null,
      secondary_window: windowWith(5 * 60 * 60, 10),
    },
  });

  assert.deepEqual(result.limitLines.map(({ label }) => label), ["5h limit"]);
  assert.match(result.statusText, /5h limit:[^\n]*90% left/);
  assert.doesNotMatch(result.statusText, /Weekly limit:/);
});

test("fails when neither top-level window is a supported duration", () => {
  assert.throws(
    () => buildCodexStatusFromWham({
      rate_limit: {
        primary_window: windowWith(60 * 60, 5),
        secondary_window: null,
      },
      additional_rate_limits: [{
        rate_limit: {
          primary_window: windowWith(5 * 60 * 60, 10),
          secondary_window: windowWith(7 * 24 * 60 * 60, 20),
        },
      }],
    }),
    /missing 5h\/weekly windows/
  );
});
