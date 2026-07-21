# Devpost Submission Plan

## Agreed Submission Shape

Bitty will be submitted with a public, under-three-minute YouTube demo and a
public prebuilt iOS Simulator app. TestFlight is intentionally out of scope.
The Simulator path reduces signing and beta-review risk while still giving
judges a no-rebuild way to inspect the app.

The demo configuration is fixed:

- iPhone Simulator;
- GPT-5.6 Luna;
- Low reasoning;
- English chat and narration;
- generic `Grocery Store` location; and
- the tracked, sessionless APNs payload with `xcrun simctl push` for a
  presentation-only notification, with an explicit disclosure that notification
  delivery is simulated while the separately verified scheduled Codex run is
  real.

## Workstreams

### 1. Submission Documentation

- [x] Record project metadata, description, repository, license, and version in
  `DEVPOST.md`; provide the Codex Session ID only in the required Devpost form
  field so it is excluded from public artifacts.
- [x] Separate pre-Build-Week capabilities from Build Week additions.
- [x] Explain how Codex and GPT-5.6 contributed.
- [x] Document the Node.js runner, Simulator setup, ports, constraints, and
  judge verification flow in English.
- [x] Remove the stale README statement that push notifications are unimplemented.
- [ ] Add the final public YouTube and GitHub Release URLs everywhere they are
  referenced.

### 2. Initial Local Setup

- [x] Confirm a clean dedicated submission worktree.
- [x] Install or verify dependencies without copying caches into the submission
  package.
- [x] Boot the target iPhone Simulator and record its device/runtime details.
- [x] Pause and ask the project owner to configure the local runner token in the
  Simulator and runner. The token must not be displayed, recorded, committed,
  or included in any artifact.
- [x] Verify runner HTTP/WebSocket connectivity after the owner finishes the
  token configuration.
- [x] Install the signed Release Simulator app and verify that the owner-entered
  Runner Token remains available after a normal app restart.

### 3. Deterministic Demo Automation

- [x] Prepare Maestro flows for the English chat prompt, file inspection,
  arrival-rule setup, and backgrounding.
- [x] Prepare `simctl location` commands for outside and inside coordinates.
- [x] Prepare a public-safe `.apns` payload for `simctl push`.
- [x] Keep the test workspace outside the repository and ensure it contains no
  private files.
- [x] Rehearse the complete path using GPT-5.6 Luna with Low reasoning and an
  English grocery-checklist prompt.
- [x] Confirm that the real location-scheduled Codex run completes successfully.
- [x] Confirm the tracked APNs payload is presentation-only and contains no
  session ID. Show the real scheduled result separately; do not imply that
  tapping this simulated notification navigates to it.

### 4. Demo Recording

Final duration: 1 minute 29 seconds.

| Time | Scene |
| --- | --- |
| `0:00–0:06` | Title and local-first positioning |
| `0:06–0:20` | Show GPT-5.6 Luna / Low and create a fresh local session |
| `0:20–0:35` | Send the English grocery prompt and show its English result |
| `0:35–0:46` | Open `買い物リスト.md` and verify the generated checklist |
| `0:46–1:06` | Configure the Grocery Store arrival rule |
| `1:06–1:17` | Background Bitty and simulate travel with `simctl location` |
| `1:17–1:24` | Separately label the real scheduled result and simulated push |
| `1:24–1:29` | Close with repository, version, license, and build attribution |

Recording checks:

- [x] Capture the iPhone Simulator and only public-safe desktop areas.
- [x] Keep every chat message and all on-screen narration in English.
- [x] Do not show tokens, `.env` files, Codex auth data, logs, account menus,
  personal paths, or unrelated notifications.
- [x] Include the on-screen disclosure: “Notification delivery is simulated on
  iOS Simulator. The scheduled Codex run is real.”
- [x] Do not imply that the presentation-only notification opens the scheduled
  result; its tracked payload intentionally has no session ID.
- [x] Use readable English on-screen text and spoken narration. Mix it with a
  quiet, original synthesized ambient bed so no third-party music license is
  required.
- [x] Export below three minutes and inspect the rendered video end to end.
- [ ] Publish the YouTube video publicly, not unlisted or private.

### 5. Prebuilt Simulator Artifact

- [x] Produce a release-mode Simulator `Bitty.app` for the recorded target.
- [x] Install and launch that exact app on a fresh compatible Simulator
  without rebuilding and without Metro.
- [x] Verify the signed Release app preserves the owner-entered Runner Token
  across a normal app restart.
- [x] Regenerate `Bitty-1.0.0-iOS-Simulator-arm64.zip` from the final signed
  Release app with this internal
  path: `Bitty-1.0.0-iOS-Simulator-arm64/Bitty.app`.
- [x] Include the public-safe notification payload and concise English install
  instructions in the release bundle or release notes.
- [ ] Record the verified macOS, Xcode, iOS runtime, and architecture in the
  GitHub Release notes.
- [ ] Publish the asset in a public GitHub Release and add its URL to
  `DEVPOST.md` and the Devpost form.

Signed app verification on July 20, 2026:

- Apple Silicon `arm64`, Xcode 26.2, iOS 26.2 Simulator;
- bundle ID `app.bitty.mobile`, version 1.0.0, minimum iOS 15.1;
- Release app contains `main.jsbundle` and launches without Metro;
- secure Runner Token persistence was verified across a normal app restart;
- final ZIP size is 23,885,284 bytes with 153 entries and no `__MACOSX`
  metadata; and
- Gitleaks found no secrets in the final staged artifact.

### 6. Packaging And Consistency Gate

- [x] Package only the signed app, tracked judge guide, license, and APNs test
  payload; no separate source archive is needed because the repository is
  public.
- [x] Exclude `.env*`, credentials, signing material, auth state, settings
  exports, logs, source dependency trees, Pods, DerivedData, native build
  output outside `Bitty.app`, and Expo/Metro caches. Compiled Expo font assets
  inside `Bitty.app` retain their original asset path names.
- [x] Inspect the complete regenerated ZIP entry list before upload.
- [x] Scan the extracted regenerated Simulator artifact for secrets. Native release
  binaries retain compiler source paths, but the package contains no local
  configuration, token, credential, or Simulator data.
- [x] Keep each submitted file or ZIP at or below 35 MB; combine multiple
  Devpost files into one ZIP.
- [ ] Confirm the README, `DEVPOST.md`, video, release notes, source history,
  and Devpost fields agree on the features and Build Week scope.
- [ ] Reuse the public-safe README screenshots for the Devpost image gallery.

## Final Submission Checklist

- [x] Project name: Bitty
- [x] Track: Developer Tools
- [x] Tagline: Control your local Codex from your iPhone or iPad.
- [ ] Repository URL is public or shared with judges.
- [ ] Public YouTube URL works while signed out.
- [ ] GitHub Release URL and Simulator asset work while signed out.
- [x] Codex Session ID is reserved for the required Devpost form field and is
  excluded from public artifacts.
- [x] Version 1.0.0 and MIT license are present.
- [x] Judge instructions are in English and require no rebuild.
- [x] TestFlight is not promised anywhere.
- [ ] Submission is completed before the deadline.
