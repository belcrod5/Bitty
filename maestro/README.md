# Maestro

This directory contains local Maestro flows for the iOS Simulator.

## Smoke Test

1. Build and install the app on an iOS Simulator.
2. Start Metro for the development build.
3. Run the smoke flow.

```bash
cd expo
npx expo run:ios --device "iPhone 17 Pro" --no-bundler
npx expo start --dev-client --localhost --port 8081
cd ..
```

```bash
./scripts/maestro/run-ios-simulator.sh
```

By default, the script uses the first booted iOS Simulator. Override it with a
Simulator UDID when needed:

```bash
MAESTRO_IOS_DEVICE=your-simulator-udid ./scripts/maestro/run-ios-simulator.sh
```

The script keeps Maestro's local home under `.maestro-home/` so sandboxed runs
do not need to write into the real user home directory.

## React Native DevTools And Load Capture

Expo SDK 54 uses React Native 0.81, so React Native DevTools is already built
into the development build workflow. Start Metro and press `j` in the Expo CLI
terminal to open it.

Use this workflow when you want to reproduce a UI issue with Maestro, keep a
screen recording, and collect a lightweight load summary for performance or bug
analysis.

1. Build and install the development build on the booted iOS Simulator.

```bash
cd expo
npx expo run:ios --device "iPhone 17 Pro" --no-bundler
cd ..
```

2. Start Metro for the development build.

```bash
cd expo
npx expo start --dev-client --localhost --port 8081
```

3. Open React Native DevTools from the Expo CLI terminal.

```text
j
```

React Native DevTools is useful for Console, Sources, Memory, Components, and
React Profiler checks. Keep it open while the Maestro run is executing when you
want to inspect runtime warnings, component state, or render behavior.

For a repeatable Maestro run with iOS Simulator video and process-load samples:

```bash
cd ..
./scripts/maestro/run-ios-simulator-with-load-report.sh
```

The script writes:

- a Simulator recording under `debug-videos/`
- a TSV sample log under `.maestro-output/perf/<run-id>/`
- a short Markdown report at `.maestro-output/perf/<run-id>/report.md`

The sampled load comes from the Simulator process list for
`app.bitty.mobile` and includes CPU percentage and RSS memory.

After the run, check:

- the video to confirm the visible UI path
- `.maestro-output/ios-smoke.png` for the final Maestro screenshot
- `.maestro-output/perf/<run-id>/report.md` for average/max CPU and RSS
- the Expo CLI console and React Native DevTools for warnings and runtime errors

Stop Metro with `Ctrl+C` when the capture is finished.
