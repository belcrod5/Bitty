# React Native macOS stability progress

Updated: 2026-08-12
Branch: `feat/react-native-macos`
Worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/react-native-macos`

## Goal

Fix the remaining macOS-only failures at their owning platform boundaries while
preserving the working iPhone behavior and avoiding scattered `Platform.OS` branches.

## Work items

- [x] Persist Runner and Cloudflare credentials across Metro reloads using the macOS
      secure-storage boundary; keep ordinary settings in the existing settings file.
- [x] Restore Skia board session addition, including the left navigation drawer's
      session-history long-press menu.
- [x] Keep the macOS Skia board mounted while visiting Settings so its
      native Canvas remains intact on return.
- [x] Render Skia card text with Paragraph and system-font fallback for Japanese
      and emoji on iOS and macOS.
- [x] Route Command + mouse-wheel input through the existing macOS pinch recognizer
      so board zoom keeps its current focal-point math and scale limits.
- [x] Enable AppKit responsive scrolling at the macOS Fabric scroll-view boundary.
- [x] Deliver AppKit live-scroll begin/end events through the macOS Fabric scroll-view
      boundary so chat follow mode pauses while the user scrolls through history.
- [ ] Improve the perceived smoothness of ordinary macOS scrolling and Skia Command
      + wheel zoom. Input support works, but the user confirmed that interpolation or
      frame pacing is still unsatisfactory; continue from the
      [smooth-scrolling handoff](MACOS-SMOOTH-SCROLL-HANDOFF.md).
- [x] Play one-shot and streamed TTS audio on macOS through the existing audio boundary;
      do not alter the backend protocol.
- [x] Run focused tests, type checking, macOS build checks, and independent diff review.
- [x] Review the full macOS diff last and remove additions that are no longer needed.

## Confirmed causes

- Before the persistence fix, the removed `secureRunnerCredentials.macos.ts` override
  stored credentials only in a module-scoped variable, so a Metro reload cleared
  them. The current owner is the shared
  `expo/src/features/app/utils/secureRunnerCredentials.ts` using the patched
  `expo-secure-store` macOS implementation.
- Skia session addition is gated by board persistence finishing its initial load. The
  drawer also needs an explicit Skia action in its session-history context menu.
- Replacing the macOS board screen unmounted and recreated its native Skia surface.
- Skia `Text` used one matched typeface, so it could not fall back for Japanese or emoji.
- Skia's native text-style converter treats a present `fontStyle` as an object, so
  normal-weight paragraphs must omit the property instead of passing `undefined`.
- React Native macOS does not expose wheel events on `View`; RNGH's native macOS
  pinch recognizer is the lowest boundary that can translate Command + wheel without
  adding a second viewport implementation to the Skia screen.
- The legacy macOS scroll view enabled AppKit responsive scrolling, but the Fabric
  `RCTEnhancedScrollView` used by this new-architecture build did not.
- The macOS Fabric scroll view emitted content-offset changes but did not translate
  AppKit live scrolling into React Native drag lifecycle events. Chat therefore kept
  follow mode active during wheel/trackpad scrolling, and a later streamed-content
  remeasurement could send the list back to the bottom.
- Before the TTS fix, `audio.macos.ts` deliberately threw from
  `Audio.Sound.createAsync`; both TTS paths already reached that boundary with
  playable media URLs. The current file implements `MacOSSound` through the native
  `BittyAudio` module.

## Constraints

- Prefer `.macos.ts` or native macOS implementations over call-site platform branches.
- Fix shared causes once at the lowest owning boundary.
- Preserve all unrelated work already present in this dirty worktree.
- The pending `main` notification lifecycle change is integrated in the current
  audit-remediation worktree; it does not replace macOS boundary fixes.

## Verification record

These entries record checks run before the macOS implementation was committed as
`6372697`. They are historical evidence, not proof that a later
smooth-scrolling change still passes. Rerun the handoff's validation gate after any
code change.

- Settings: postinstall patch application passes; secure-settings tests pass (2
  suites / 12 tests); ExpoSecureStore is registered and macOS Debug arm64 builds.
  Metro-reload verification remains.
- Skia: AppDrawer, Skia session hook, and macOS modal tests pass (3 suites / 33
  tests), including failed-read recovery without overwriting existing board data;
  TypeScript and `git diff --check` pass. Device verification remains.
- Skia navigation/font follow-up: focused screen-content and board tests pass;
  TypeScript, iOS bundling, and `git diff --check` pass. Manual Settings
  round-trip on macOS and Japanese/emoji rendering on macOS and iPhone remain.
- Skia Command + wheel: RNGH patch-package clean reapplication, focused board tests
  (19), TypeScript, diff checks, and macOS Debug arm64 native build pass. Manual
  cursor-focal zoom and ordinary-scroll verification remain.
- Scrolling: the `react-native-macos` patch reapplies successfully; Drawer, layout,
  and Chat tests pass (3 suites / 18 tests), TypeScript passes, and the patched Fabric
  scroll source compiles into the Debug arm64 object/library. The Command + wheel
  patch also removes the earlier invalid RNGH `scrollWheel:` superclass calls, and
  the full Debug arm64 build passes. Manual mouse and trackpad verification remains.
- Chat history scrolling: AppKit live-scroll notifications now emit the existing
  React Native begin/end-drag lifecycle on macOS, including the unbracketed legacy
  mouse fallback. Clean patch reapplication, focused Chat tests, TypeScript, and
  Debug arm64 compilation pass; the user confirmed that scrolling upward no longer
  jumps back to the bottom.
- TTS: relevant tests pass (2 suites / 5 tests), TypeScript and plist checks pass,
  and macOS Debug arm64 builds succeed. Audible playback verification remains.
- Full Expo suite: 101 suites / 706 tests pass. Existing SafeAreaView deprecation
  warnings remain; there are no test failures.
- Independent review of the then-completed Skia persisted-state recovery found no
  blocker or major issue. The unfinished smooth-scrolling work was outside that
  review's completion claim.
- Cleanup: removed temporary chat-layout diagnostics, unsuccessful rerender experiments,
  macOS-unreachable modal changes, stale investigation documents, the unused RaTeX
  package pin, and the empty iOS target from the macOS Xcode project. Corrected the
  case-sensitive macOS Info.plist path.
- Native project: pod install, plist validation, target listing, and macOS Debug arm64
  build pass after cleanup. The Release arm64 build reaches a pre-existing dependency
  error in `react-native-enriched-markdown` (`BOOL` to `bool` narrowing); this requires
  a separate upstream-compatible dependency fix.
