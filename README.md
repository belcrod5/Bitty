# Bitty

Bitty is a local-first mobile chat client for working with a private runner on
your own machine. The app is built with Expo / React Native, and the runner is
a small Node.js service that connects the mobile app to local tools, speech
services, and Codex-style coding sessions.

## Repository Layout

- `expo/`: Expo / React Native mobile app
- `private_runner/`: local runner service
- `scripts/`: development and device-build helper scripts
- `maestro/`: optional iOS simulator smoke-test flows

## Requirements

- Node.js
- npm
- Codex CLI (`codex`)
- Xcode for iOS builds
- Expo development tooling

Optional integrations such as Google Cloud TTS, YouTube API, ElevenLabs, and
local speech services are configured through `private_runner/.env`.

## Quick Start

1. Install the runner dependencies and create local config:

```bash
cd private_runner
npm install
cp .env.example .env
```

2. Edit `private_runner/.env` and set at least:

```env
RUNNER_TOKEN=replace-with-a-long-random-string
CODEX_HOME=$HOME/.codex
```

3. Log in to Codex for the runner:

```bash
node setup-codex-auth.mjs
```

For headless setup, use:

```bash
node setup-codex-auth.mjs --device-auth
```

4. Start the local runner:

```bash
./run-local.sh start --mode full
```

Useful runner commands:

```bash
./run-local.sh status
./run-local.sh restart --mode full
./run-local.sh stop --mode full
```

5. Install and start the mobile app:

```bash
cd ../expo
npm install
npx expo start --dev-client
```

In the app settings, set:

- iOS Simulator: `Runner URL = http://127.0.0.1:8788`
- Real device: `Runner URL = http://<your Mac LAN IP>:8788`
- `Runner Token`: the same value as `RUNNER_TOKEN` in `private_runner/.env`

The runner writes local logs under `private_runner/logs/`. Logs and local auth
state are intentionally ignored by Git.

## Native iOS Builds

For iOS native builds, configure local signing/device settings outside Git:

```bash
cd ..
cp .env.ios.local.example .env.ios.local
```

Set `IOS_DEVICE_ID` in `.env.ios.local`, then run:

```bash
./scripts/ios/build-expo-ios-device.sh
```

By default the public app identity is:

- App name: `Bitty`
- Expo slug: `bitty`
- iOS bundle identifier: `app.bitty.mobile`
- Settings file name: `bitty-settings.json`

## Settings Migration

The app includes clipboard-based settings export/import for complete
device-to-device migration.

The exported settings JSON can contain private data such as local URLs, paths,
session metadata, and approval rules. Do not publish exported settings files.
For OSS defaults, choose safe values manually in source code or example config
files.

## Optional Google Cloud Settings

Google Cloud is not required for the default local setup.

It is only used when you choose Google Cloud Text-to-Speech, or when YouTube
tools fall back to `gcloud` authentication instead of `YOUTUBE_API_KEY`.

```env
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_TTS_LANGUAGE_CODE=ja-JP
GOOGLE_CLOUD_TTS_VOICE_NAME=ja-JP-Neural2-B
```

## Tests And Checks

```bash
cd expo
npx tsc --noEmit
```

```bash
cd ..
node --test private_runner/tests/*.test.mjs
```

The runner package currently does not define an `npm test` script; use the
Node.js test runner command above.

## Security

See `SECURITY.md`.

## License

MIT
