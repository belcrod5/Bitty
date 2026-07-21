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

## Devpost Simulator Demo

The Devpost recording flow is split at the state boundaries that need a visible
manual checkpoint. It never reads or writes runner tokens.

Before the first live run, the owner must select the demo workspace/session and
enter the Runner Token and Codex WS Token in Bitty once. The signed Release
Simulator app stores those values in secure storage across normal app restarts.
Also grant `Always` location permission to Bitty and remove any old location
schedule rules.
Keep tokens, settings screens, and terminal logs out of the desktop capture.

Run the phases in order:

```bash
./scripts/devpost/run-simulator-demo.sh check
./scripts/devpost/run-simulator-demo.sh outside
./scripts/devpost/run-simulator-demo.sh chat
./scripts/devpost/run-simulator-demo.sh file
./scripts/devpost/run-simulator-demo.sh rule
./scripts/devpost/run-simulator-demo.sh arrive
./scripts/devpost/run-simulator-demo.sh notify
```

The `rule` phase deliberately creates a window that starts two minutes in the
future. A rule created or edited inside its active window is intentionally
skipped by the runner, so do not change the rule after saving it. Run `arrive`
only after the printed start time.

`arrive` uses `xcrun simctl location` to cross the real geofence while Bitty is
in the background. The rehearsed location-triggered run completed successfully
with GPT-5.6 Luna, Low reasoning, and the English grocery-checklist prompt.
Show that real scheduled result in Bitty as its own demo step.

For the separate public-safe, presentation-only notification step, use the
tracked payload without a session ID:

```bash
./scripts/devpost/run-simulator-demo.sh notify
```

If the banner is not visible, open Notification Center to show the delivered
notification. The tracked payload intentionally has no `sessionId`, so this
step demonstrates Simulator notification presentation only. Do not describe or
record it as navigation to the scheduled Codex session.

The flows target a portrait iPhone Simulator. Point selectors remain where
React Native controls are not exposed reliably to XCTest: eight in the chat flow
and six in the location-rule flow. Rehearse those selectors on the exact
Simulator used for recording.

Store the five selected source clips under the Devpost artifact directory as:

```text
recordings/chat.mp4
recordings/file.mp4
recordings/location-rule.mp4
recordings/arrival.mp4
recordings/notifications.mp4
```

Then build the public 16:9 demo with:

```bash
./scripts/devpost/build-demo-video.sh
```

The script produces `Bitty-Devpost-Demo.mp4` in the Devpost artifact directory,
adds English on-screen narration, removes rehearsal wait time, and keeps the
simulated push visually separate from the real scheduled Codex result.

To add the prepared narration clips from `voices/1.mp4` through `voices/8.mp4`,
run:

```bash
./scripts/devpost/add-demo-audio.sh
```

This keeps the silent video unchanged and writes
`Bitty-Devpost-Demo-Voiceover.mp4`. The script trims only the leading and
trailing silence from each voice clip, places the eight clips on the fixed demo
timeline, and ducks a quiet original ambient bed under speech. The ambient bed
is synthesized by ffmpeg and does not use third-party music.
