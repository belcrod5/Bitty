# Voice input cues

`voice-input-ready.wav` and `voice-input-send.wav` are the adopted "Neon Relay"
pair, each 420 ms at 44.1 kHz mono PCM16. The ready cue rises from 415.305 Hz to
622.254 Hz; the send cue descends between the same notes. Decaying FM and a brief
glass overtone give the notes their soft metallic tone. Three echoes follow at
57, 114, and 171 ms with gains of 0.34, 0.135, and 0.055, followed by a gentle fade.
The existing JavaScript generator reproduces the adopted audition byte for byte;
regression tests pin both WAV hashes. No Python runtime or preview files are needed.
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
