# Bitty — Devpost Submission

## Submission Details

- **Project:** Bitty
- **Track:** Developer Tools
- **Tagline:** Control your local Codex from your iPhone or iPad.
- **Version:** 1.0.0
- **License:** MIT
- **Platforms:** macOS local server, iPhone, and iPad
- **Repository:** https://github.com/belcrod5/Bitty
- **Public demo video:** `[Add public YouTube URL before submission]`
- **Prebuilt iOS Simulator app:** `[Add public GitHub Release URL before submission]`
- **Codex Session ID:** Provide only in the required Devpost form field; it is
  intentionally excluded from public artifacts.
- **Built with:** Codex, GPT-5.6, React Native, Expo, TypeScript, Node.js,
  WebSocket, iOS, and Xcode

## What Bitty Does

Bitty is a local-first iOS companion for Codex. It lets developers start and
resume local Codex sessions, send prompts by voice, review approvals, inspect
files and Git changes, and monitor multiple coding tasks from an iPhone or
iPad. The developer's workspace and Codex process remain on their own Mac; the
mobile app is a focused control surface for that local runner.

## What Existed Before Build Week

Bitty was an existing project before OpenAI Build Week. Its baseline already
included:

- starting, resuming, and monitoring local Codex sessions;
- text and voice prompting with TTS playback;
- mobile approval review;
- workspace file and Git-diff inspection; and
- the drawer and Mini Board for monitoring multiple tasks.

## What Changed During Build Week

The Build Week work is distinct from that baseline:

- added native iOS push notifications for completed turns and approval
  requests;
- added location- and time-window-triggered Codex runs, including map-based
  location selection and background recovery;
- added Markdown and text-file creation/editing needed to complete workflows
  from the phone;
- recovered the connection when the app returns from the background;
- made WebSocket reconnection and turn recovery more reliable;
- improved switching between Codex authentication profiles;
- fixed automatic voice conversation and TTS playback; and
- improved context-usage reporting.

The repository history and the location/push design and verification documents
under `docs/` provide evidence for these changes.

## How Codex And GPT-5.6 Contributed

Codex was used as an engineering collaborator throughout Build Week to inspect
the existing runner and mobile boundaries, propose designs, implement scoped
changes, add regression tests, run simulator verification, and review the
resulting diffs. The work kept location decisions in the iOS scheduling layer
and reused the runner's existing Codex execution boundary instead of creating a
second execution path. Reliability work also made unsafe or stale schedule
state fail closed.

GPT-5.6 powered the Codex collaboration and is used in the recorded demo.
**GPT-5.6 Sol** was used with Codex to produce the submission demo video. Inside
the app, the demonstrated chat and scheduled Codex run select **GPT-5.6 Luna**
with **Low** reasoning through the existing Codex authentication path; Bitty
does not introduce a separate API key.

## Demo

The prepared 89-second public video uses an iPhone Simulator. All chat messages,
on-screen narration, and spoken narration are in English. The central prompt is:

> Let's have tacos for dinner tonight. Create a grocery checklist and save it
> as `買い物リスト.md` in this workspace. Write the file contents and your
> reply in English. Then tell me what you saved.

The demo then verifies the new file, configures a Grocery Store arrival rule,
moves the simulated device with `xcrun simctl location`, and shows the actual
scheduled Codex result. This location-triggered path has been rehearsed
successfully with GPT-5.6 Luna, Low reasoning, and the English grocery-checklist
prompt.

The visible notification is delivered separately with `xcrun simctl push` and
the tracked presentation-only payload. The payload intentionally has no session
ID, so the video may open Notification Center to show delivery but does not
claim that tapping it navigates to the scheduled session. This validates the
app's iOS notification presentation on Simulator; it does not claim to test
Apple's production APNs delivery service. The video discloses:
**“Notification delivery is simulated on iOS Simulator. The scheduled Codex
run is real.”**

## Judge Access Without Rebuilding

TestFlight is intentionally out of scope for this submission. A public GitHub
Release will provide `Bitty-1.0.0-iOS-Simulator-arm64.zip`, containing a
prebuilt app at:

```text
Bitty-1.0.0-iOS-Simulator-arm64/Bitty.app
```

The release notes will record the exact macOS, Xcode, Simulator runtime, and
Mac architecture used to verify the artifact. The target verification
environment is Apple Silicon macOS with Xcode 26.2 and a compatible iOS
Simulator runtime.

### Requirements And Constraints

- macOS with Xcode and an iOS Simulator runtime compatible with the release;
- Apple Silicon for the provided Simulator build, unless the release notes say
  otherwise;
- Node.js 22 and npm;
- the Codex CLI installed and authenticated on the Mac;
- a local checkout of this repository for the Node.js runner;
- location and notification permissions granted to Bitty in Simulator; and
- no physical iPhone, Apple Developer account, TestFlight access, or app rebuild
  is required.

Bitty is local-first. The Simulator and runner must run on the same Mac for the
loopback URLs below. Codex itself may require network access according to the
user's Codex configuration. Optional TTS and YouTube integrations are not
required for the judge path.

### Ports

| Port | Service | Required |
| --- | --- | --- |
| `8788` | Bitty Node.js runner HTTP and WebSocket endpoint | Yes |
| `4500` | Local Codex app-server WebSocket used by the runner | Yes in full mode; loopback only |
| `8081` | Expo Metro development server | No for the prebuilt release app |
| `10101` | Optional local AivisSpeech API | No |

### 1. Start The Local Node.js Runner

```bash
git clone https://github.com/belcrod5/Bitty.git
cd Bitty/private_runner
npm install
cp .env.example .env
```

Edit `private_runner/.env`. Create your own local token; never use a token from
the repository or release archive:

```env
HOST=127.0.0.1
PORT=8788
RUNNER_TOKEN_MODE=env
RUNNER_TOKEN=replace-with-your-own-long-random-token
CODEX_APP_SERVER_LISTEN=ws://127.0.0.1:4500
CODEX_HOME=/absolute/path/to/your/.codex
```

Authenticate Codex and start both the runner and Codex app-server:

```bash
node setup-codex-auth.mjs
./run-local.sh start --mode full
./run-local.sh status
```

The token is local configuration. Do not paste it into a bug report, video,
submission form, settings export, or log archive.

### 2. Install The Prebuilt iOS Simulator App

Download and unzip `Bitty-1.0.0-iOS-Simulator-arm64.zip` from the public
release, then boot an iPhone Simulator and install the included app:

```bash
open -a Simulator
xcrun simctl bootstatus booted -b
xcrun simctl install booted ./Bitty-1.0.0-iOS-Simulator-arm64/Bitty.app
xcrun simctl launch booted app.bitty.mobile
```

No Metro server is needed for this prebuilt release build.

### 3. Connect Bitty To The Runner

Open Bitty's connection settings and enter:

- **Runner URL:** `http://127.0.0.1:8788`
- **Runner Token:** the local `RUNNER_TOKEN` created above
- **Codex WS URL:** `ws://127.0.0.1:8788/runner-ws`
- **Codex WS Token:** the same local runner token

Enter the tokens once and wait briefly for settings persistence before leaving
the screen. The signed Release Simulator app stores them securely across normal
app restarts.

Select **GPT-5.6 Luna** and **Low** reasoning for the submission scenario.

## Feature Verification

1. Confirm the runner status is connected in Bitty.
2. Start a new Codex session in a temporary, non-sensitive workspace.
3. Send the English grocery prompt from the Demo section.
4. Open the file browser and verify that `買い物リスト.md` contains the
   generated grocery checklist.
5. Open the directory's location schedule settings. Create a Grocery Store
   rule with a current time window and this English prompt:

   > When I arrive at the Grocery Store, read `買い物リスト.md`, show me the
   > checklist, and remind me what to buy. Reply in English.

6. Grant Always location and notification permissions when requested, set the
   Simulator outside the region, and put Bitty in the background.
7. Move the Simulator into the configured region using coordinates that match
   the rule:

   ```bash
   xcrun simctl location booted set <latitude>,<longitude>
   ```

8. Wait for the real location-scheduled Codex turn to complete and verify its
   result in Bitty.
9. To test Simulator notification presentation separately, use the tracked
   APNs test payload included in the release bundle:

   ```bash
   xcrun simctl push booted app.bitty.mobile ./Bitty-1.0.0-iOS-Simulator-arm64/maestro/payloads/devpost-notification.apns
   ```

10. Verify that the notification is shown, opening Notification Center if the
    banner is not visible. The tracked payload has no session ID and is not a
    scheduled-session navigation test. This is simulated notification delivery,
    not a production APNs test.

The remaining baseline features can be checked by resuming a session, reviewing
an approval request, opening Git changes, and viewing multiple tasks in Mini
Board.

## Security And Submission Packaging

- The release and any Devpost attachment must contain no `.env` files, runner
  tokens, Codex auth state, API keys, certificates, provisioning profiles,
  settings exports, private workspace data, or personal paths.
- Do not package source dependency trees such as source `node_modules` or
  `Pods`, native build directories, Metro/Expo caches, DerivedData, runner
  logs, test output, or local database/state files. Compiled app assets may
  retain their original package path names inside `Bitty.app`.
- Create source archives from Git-tracked files only.
- If multiple files are attached to Devpost, combine them into one ZIP.
- Verify every uploaded file or ZIP is no larger than 35 MB.
- Scan the final archive contents and extracted files for secrets before
  publishing.
- Confirm that this document, the README, the public video, release notes, and
  Devpost form describe the same features, model, notification simulation, and
  Build Week scope.

## Links To Add Before Submission

- Public YouTube demo: `[TBD]`
- Public GitHub Release with Simulator app: `[TBD]`
