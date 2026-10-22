# Voice input cues

`voice-input-ready.wav` (212 ms) and `voice-input-send.wav` (178 ms) are original,
procedurally synthesized notification-style chimes. Each note combines a sine fundamental, an octave below for body, and second/third
harmonics for clarity, with short attack/release envelopes at 44.1 kHz mono PCM16.
The rising ready cue and falling send cue are distinct from each other.
The ready WAV lives in `expo/modules/bitty-stt-transport/ios/Resources/` so native
iOS capture can play it without reconfiguring the recording audio session.
JavaScript/macOS reference that same file; there is no duplicated audio asset.
No downloaded samples or push notification WAVs are used or modified.

Regenerate only these two files from `expo/`:

```sh
node ../scripts/generate-retro-sfx.mjs --voice-input-only
```

# Orchestrator session reset cue

`voice-reset-confirmation.wav` (390 ms) is an original notification-style two-note
bell, synthesized from sine tones and a quiet bell overtone at 44.1 kHz mono PCM16.
It plays before the session reset confirmation appears. No downloaded samples or
existing push notification WAVs are used or modified.

Regenerate only this file from `expo/`:

```sh
node ../scripts/generate-retro-sfx.mjs --voice-reset-only
```
