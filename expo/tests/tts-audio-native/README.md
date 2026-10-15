# Native TTS audio preparation checks

On a Mac with Xcode command line tools:

```sh
python3 expo/tests/tts-audio-native/run.py
```

The harness compiles the production `BittyTtsEffectsModule.mm` with a minimal React bridge shim. Local fixtures exercise the exported preparation method with no effect and with audio effects, including mono/stereo, quiet speech, internal pauses, all-silent and empty input, cancellation cleanup, and removal of the fixed 180 ms effect tail. It uses real AVFoundation file reads/writes and AudioUnits. Environments restricting AudioUnit access must allow the local test process to use Apple's audio services.

Optionally pass a directory of existing MP3 files to compare decoded source duration with prepared plain/themed duration:

```sh
python3 expo/tests/tts-audio-native/run.py /absolute/path/to/tts-media
```

Only file counts and aggregate duration reductions are printed. Cached audio is not modified, uploaded, or committed. Temporary test audio is removed automatically. This verifies local processing, not actual device playback gaps or perceived sound quality.
