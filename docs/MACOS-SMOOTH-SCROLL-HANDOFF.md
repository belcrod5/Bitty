# macOS smooth scrolling handoff

Updated: 2026-08-12

Branch: `feat/react-native-macos`

Worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/react-native-macos`

## Objective

Improve the feel of these macOS inputs without changing the working iPhone
behavior:

1. Mouse-wheel and trackpad scrolling in Drawer, Chat, and Current Settings.
2. Command + mouse-wheel zoom on the Skia board.

Fix missing behavior at its owning dependency/platform boundary. Do not add
per-screen smoothing, JS timers, repeated `scrollTo...` calls, or platform branches
at each call site.

## Start here

The macOS implementation and all four dependency patches are tracked in commit
`6372697e824c60e7b25bb8de94e91d7d157166f7`. The current worktree also contains the
uncommitted follow-up that integrates `origin/main` at
`23d1f4dd094ab49f90b1627627fca6da06784f23` and resolves the diff-audit blockers.
`docs/REACT-NATIVE-MACOS-DIFF-AUDIT.md` remains intentionally untracked until that
follow-up is reviewed.

Continue in the exact worktree above and inspect its current merge/worktree state
before editing:

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/react-native-macos
git status --short
git log --oneline --decorate -5
sed -n '1,260p' expo/patches/react-native-macos+0.81.9.patch
sed -n '1,360p' expo/patches/react-native-gesture-handler+2.28.0.patch
```

For this task, change only the owning dependency source, its matching patch-package
file, and the smallest regression-test/documentation surface required by the result.
Treat the audit-remediation diff and all unrelated changes as user-owned. In
particular, do not commit, reset, discard, or broadly reformat them.

Read the [stability progress record](REACT-NATIVE-MACOS-STABILITY-PROGRESS.md) before
starting. Its verification results are historical evidence for the current dirty
diff, not a substitute for rerunning the relevant checks after a new code change.

## User-verified state

- Fixed: Chat no longer jumps to the bottom while the user is reading older messages.
- Still unsatisfactory: Drawer, Chat, and Current Settings do not feel smoothly
  scrolled.
- Still unsatisfactory: Skia Command + wheel zoom changes scale too abruptly.

The Chat jump and the remaining smoothness requests are different problems. Do not
undo or retune the Chat lifecycle/follow-mode fix while tuning input feel.

## Existing dependency-boundary patches

These are local patch-package changes at upstream-owned boundaries. They have **not**
been shown to be merged upstream. "Upstream first" below means fixing or backporting
the dependency implementation before adding app-level behavior; it does not mean the
current local patches are official releases.

### React Native macOS scroll view

Patch: `expo/patches/react-native-macos+0.81.9.patch`

- Enables `+isCompatibleWithResponsiveScrolling` on the Fabric
  `RCTEnhancedScrollView`, matching the legacy macOS scroll view.
- Bridges AppKit live-scroll start/end notifications to React Native's existing
  begin/end-drag lifecycle.
- The lifecycle bridge fixed the Chat bottom jump because `ChatScreen` can now pause
  follow mode when a macOS wheel or trackpad interaction begins.
- The changes are inside `TARGET_OS_OSX`; iOS is not compiled through them.

Important limitation: this flag does **not** promise temporal interpolation of
discrete mouse-wheel ticks. AppKit requires the scroll view, clip view, and document
view to be compatible; its stock classes already report compatibility, so the Fabric
override may be parity-only rather than a visible improvement. The user confirmed
that this patch alone does not provide the desired feel. See Apple's
[`isCompatibleWithResponsiveScrolling`](https://developer.apple.com/documentation/appkit/nsview/iscompatiblewithresponsivescrolling)
contract.

### Command + wheel to the existing pinch path

Patch: `expo/patches/react-native-gesture-handler+2.28.0.patch`

- A macOS local wheel monitor converts Command + wheel inside the pinch target into
  the existing RNGH pinch lifecycle.
- It keeps the Skia board's existing cursor focal-point calculation and scale limits.
- Precise trackpad deltas and discrete mouse ticks are normalized, but every update is
  still applied immediately. No visual interpolation or decay currently exists.
- Ordinary wheel events are returned unchanged, and iOS is outside the macOS compile
  branch.

Board consumer: `expo/src/features/app/screens/SkiaMiniBoardScreen.tsx`

- Existing scale range: `0.25` to `2.5`.
- Existing pinch update writes `scale`, `boardX`, and `boardY` together so the focal
  point stays under the cursor.
- Keep this single transform owner. Do not add a second macOS zoom state machine.

## Required investigation and decision procedure

Do not tune constants first. Complete these steps in order and record the evidence in
this document or the progress record.

### 1. Check upstream before extending a local patch

For each affected dependency:

1. Check the matching release branch/tag and current upstream source, issues, and pull
   requests for the same behavior.
2. Record the URL, branch/tag, commit SHA if applicable, and investigation date.
3. If an upstream fix exists and is compatible with the pinned version, prefer the
   smallest backport of that fix.
4. If no fix exists, keep the change local to the same dependency boundary and shape
   it so it can be proposed upstream. Do not compensate in app screens.

Upstreams:

- React Native macOS: <https://github.com/microsoft/react-native-macos>
- React Native Gesture Handler:
  <https://github.com/software-mansion/react-native-gesture-handler>

### 2. Capture a baseline and classify native input

Reproduce separately with:

- a traditional/discrete mouse wheel;
- a precise trackpad gesture;
- Drawer, Chat, and Current Settings;
- Command + wheel on both an empty Skia board and a board with many Paragraph-backed
  cards;
- macOS Debug and, when the Release blocker below is resolved, Profile/Release.

Add **temporary native diagnostics only at the existing owning boundaries**:

- ordinary scroll: `RCTEnhancedScrollView`'s `scrollWheel:` entry point candidate;
- Command + wheel: `RNBetterPinchRecognizer`'s existing
  `handleCommandWheelEvent:` method.

For representative interactions, capture:

| Field | Why |
| --- | --- |
| target screen and input device | Separates consumer and hardware behavior |
| `hasPreciseScrollingDeltas` | Separates precise gestures from discrete ticks |
| `phase` and `momentumPhase` | Shows gesture lifetime and native momentum |
| `scrollingDeltaX/Y` and direction inversion | Preserves axes and natural-scroll direction |
| event timestamp and interval | Distinguishes coarse input from event starvation |
| rendered-frame interval or missed frames | Distinguishes input shaping from render cost |
| board card count | Exposes Paragraph/Canvas rendering cost |

Remove diagnostics before handoff. Debug overhead can look like a smoothing failure,
so do not conclude that an interpolator is needed from Debug feel alone. The scheme's
Profile action uses Release; currently that path is blocked by the unrelated
`react-native-enriched-markdown` narrowing error described below. Until that blocker
is fixed separately, record the Debug measurements and mark optimized frame-pacing
verification as blocked rather than claiming it passed.

### 3. Choose the fix from evidence

| Observation | Owning response |
| --- | --- |
| An upstream dependency fix already exists | Backport it into the matching patch-package file |
| Precise trackpad phase/momentum is intact; only phase-less discrete ticks jump | Shape only non-precise, phase-less ticks at the native dependency boundary |
| Precise events or momentum are lost before the consumer | Correct native event forwarding; do not add interpolation |
| Event cadence is smooth but frames are missed, especially on a populated board | Profile rendering; do not hide render cost with input delay |
| Only one app screen misbehaves with the same native stream | Investigate that consumer before changing generic native behavior |
| All native streams are correct and macOS intentionally steps discrete wheels | Document the platform behavior and tradeoffs, then consider one native interpolator |

Do not change precise trackpad behavior merely because a traditional wheel needs
shaping. Re-test after the first owning-boundary correction and stop if it solves the
problem; do not implement both input interpolation and rendering changes speculatively.

## Implementation boundaries

### Ordinary scrolling

All relevant screens reach the Fabric native ScrollView through `ScrollView` or
LegendList. Generic behavior therefore belongs to React Native macOS/AppKit, with
`RCTEnhancedScrollView` as the current Fabric candidate. The legacy
`RCTCustomScrollView` is reference behavior, not the New Architecture runtime owner.

Prefer AppKit's native scrolling/momentum behavior or an upstream-compatible React
Native macOS correction. Avoid synthesizing animation with JS `onScroll`, replacing
LegendList, or adding `decelerationRate`/`scrollEventThrottle` without evidence:

- `scrollEventThrottle` only changes JS callback frequency;
- the existing macOS Fabric implementation does not use the iOS deceleration path in
  the same way;
- JS interpolation can fight AppKit momentum, nested scrolling, scroll bars,
  accessibility, and virtualization.

If evidence requires a native discrete-wheel interpolator, it must be implemented
once at the Fabric scroll boundary and obey all of these invariants:

- precise events, phaseful gestures, and momentum continue through AppKit unchanged;
- a new discrete tick updates the current target instead of starting an independent
  timer/animation;
- begin/end-drag remains one correctly bracketed interaction, and end is not emitted
  before any native interpolation completes;
- vertical/horizontal axes, Shift + wheel, natural-scroll direction, bounds,
  elasticity, and scrollbar state remain correct;
- an inner scroll view that cannot consume further movement does not trap movement
  that should reach a parent;
- cancellation, window loss, view removal/recycling, and disabled scrolling stop the
  state cleanly with no residual motion;
- Reduce Motion and keyboard/accessibility scrolling are not degraded.

Do not copy the legacy `scrollWheel:` override blindly: it currently forwards to
`super` and does not itself provide temporal interpolation.

### Skia zoom

Keep Command + wheel recognition in the RNGH macOS pinch boundary because React Native
macOS does not expose an `onWheel` event on `View`. First determine whether abruptness
comes from:

- one large exponential scale step per discrete tick;
- gesture grouping ending too quickly (`120 ms` currently);
- lack of intermediate pinch updates between current and target scale;
- trackpad phase or momentum being discarded;
- missed render frames on a populated board.

RNGH owns recognition and emitted pinch `scale`/`focalPoint`. The shared Skia screen
owns the final transform and clamp. If native input shaping is required, RNGH should
emit intermediate events through the **existing pinch contract**; the existing JS
`onUpdate` must remain the place that atomically derives `scale`, `boardX`, and
`boardY`. Do not attempt to write the board transform from native RNGH code.

Any shaping must obey these invariants:

- a new wheel tick updates the active target and gesture generation;
- intermediate events preserve the same focal-point coordinate contract;
- the gesture does not end before its final emitted update;
- modifier release, cancel, window/view loss, disable, reset, and deallocation cancel
  pending work;
- no callback captures a stale event/view after teardown;
- natural direction, sensitivity, and the existing `0.25...2.5` clamp remain intact;
- reaching a clamp does not prevent immediately reversing direction;
- ordinary wheel is returned unchanged, including after Command is released;
- trackpad phase/momentum is not converted to phase-less mouse behavior unless
  measurements prove that is the missing contract.

Do not animate `scale` alone. The existing consumer must receive enough updates to
keep `boardX` and `boardY` coupled to the cursor focal point.

## `.macos.ts(x)` policy

Use `.macos.ts` or `.macos.tsx` when a JavaScript/module implementation is truly
different on macOS and Metro already owns the platform selection. Existing examples
include audio, clipboard, camera, modal, drawer layout, and screen-content lifetime
boundaries.

Production imports must remain extensionless, for example `import { Audio } from
"./audio"`. Metro selects `.macos.ts(x)` for a macOS bundle and falls back through
its platform resolution order. The custom `metro.config.js` does not create that
suffix behavior; it aliases `react-native[/...]` to `react-native-macos[/...]` for
the macOS platform. Keep the common and macOS modules' exports and types identical.

`tsc` and ordinary Jest resolution do not prove that the `.macos.ts(x)` production
variant was selected. Type checking can resolve the common file, and the Jest preset
does not define macOS as its default platform. A macOS native bundle/build is the
integration check; explicit `.macos` imports are reserved for focused macOS variant
tests already following that pattern.

Do not use `.macos.ts(x)` when the required event is not exposed to JavaScript. For
these remaining issues:

- ordinary scroll behavior belongs to the React Native macOS native ScrollView;
- Command + wheel recognition belongs to RNGH's macOS native recognizer;
- shared `ChatScreen.tsx` and `SkiaMiniBoardScreen.tsx` should remain free of new
  `Platform.OS === "macos"` branches unless measurements prove a JS-owned difference.

The rule is to select the lowest existing owner, not to create a `.macos.ts` wrapper
that only forwards calls. A `.macos.ts(x)` file is not a substitute for a missing
native event contract.

## Prohibited downstream and force-fit fixes

- Do not add JS or screen-level timers, animation frames, or repeated `scrollToEnd`
  calls to mask smoothness. `ChatScreen` already has bottom-settling retries for a
  separate responsibility; do not remove, retune, or copy them in this task. A single
  native frame clock is acceptable only if measurements select the native
  interpolator described above.
- Do not grow `ChatScreen.tsx`; it is already over the repository's 2,000-line limit.
- Do not infer user intent from viewport aspect ratio alone.
- Do not fork Chat follow behavior for macOS; it now receives the native drag
  lifecycle.
- Do not delay, coalesce, or replace precise trackpad events to smooth discrete input.
- Do not add per-screen scroll props without a measured native contract.
- Do not add a JS wheel listener, global Command-key listener, second viewport state
  machine, or Canvas overlay for board zoom.
- Do not replace LegendList or change `@legendapp/list` positioning as a smoothing
  experiment. Its patch fixes macOS item placement and is not the input owner.
- Do not copy dependency source into the app or create a forwarding wrapper.
- Do not patch `node_modules` without regenerating and reviewing the matching
  patch-package file.
- Do not mix a dependency upgrade, the Release narrowing fix, or unrelated cleanup
  into this task.
- Do not commit or discard unrelated changes in this dirty worktree.

## Relevant files and ownership

| File | Role |
| --- | --- |
| `expo/patches/react-native-macos+0.81.9.patch` | Persistent RN macOS dependency diff; expected owner for generic scrolling |
| `expo/node_modules/react-native-macos/React/Fabric/Mounting/ComponentViews/ScrollView/RCTEnhancedScrollView.h` | Fabric scroll subclass declaration |
| `expo/node_modules/react-native-macos/React/Fabric/Mounting/ComponentViews/ScrollView/RCTEnhancedScrollView.mm` | Fabric `NSScrollView`; ordinary-wheel investigation point |
| `expo/node_modules/react-native-macos/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm` | RN scroll events and AppKit live-scroll lifecycle bridge |
| `expo/node_modules/react-native-macos/React/Views/ScrollView/RCTScrollView.m` | Legacy reference, including parity flag and forwarding `scrollWheel:` |
| `expo/node_modules/react-native-macos/React/Base/macOS/RCTUIKit.m` | `RCTUIScrollView` compatibility layer; inspect before choosing a more generic owner |
| `expo/patches/react-native-gesture-handler+2.28.0.patch` | Persistent RNGH dependency diff; expected owner for Command + wheel recognition |
| `expo/node_modules/react-native-gesture-handler/apple/Handlers/RNPinchHandler.m` | Existing Command + wheel recognizer and diagnostics point |
| `expo/src/features/app/screens/SkiaMiniBoardScreen.tsx` | Shared pinch consumer; owns transform/focal-point math, not wheel recognition |
| `expo/src/features/app/screens/ChatScreen.tsx` | Shared Chat follow state; regression reference only for generic smoothness |
| `expo/src/features/app/components/AppDrawer.tsx` | Plain `ScrollView` reproduction surface |
| `expo/src/features/app/screens/DebugScreen.tsx` | Current Settings plain `ScrollView` reproduction surface |
| `expo/patches/@legendapp+list+2.0.19.patch` | macOS list item-placement fix; preserve unless profiling implicates it |
| `expo/metro.config.js` | Maps `react-native` imports to `react-native-macos` for macOS |
| `expo/app.json` | Confirms New Architecture is enabled |
| `expo/package.json` and `expo/package-lock.json` | Pinned dependency versions and patch-package command |
| `expo/macos/Podfile` | Native dependency/autolinking setup; change only if dependency shape changes |
| `expo/macos/bitty.xcworkspace` | Native macOS build workspace |
| `expo/macos/bitty.xcodeproj/xcshareddata/xcschemes/bitty-macOS.xcscheme` | Debug/Release scheme configuration |
| `expo/src/features/app/components/AppScreenContent.macos.tsx` | Example of a real macOS-specific lifetime implementation |
| `expo/src/features/app/components/AppDrawerLayout.macos.tsx` | Example of a real macOS-specific layout implementation |

Regression tests:

- `expo/src/features/app/components/AppDrawer.test.tsx`
- `expo/src/features/app/components/AppDrawerLayout.test.tsx`
- `expo/src/features/app/components/AppScreenContent.macos.test.tsx`
- `expo/src/features/app/screens/ChatScreen.autoRecordingPanel.test.tsx`
- `expo/src/features/app/screens/SkiaMiniBoardScreen.test.tsx`

The current tests protect app consumers; they do not generate AppKit wheel events or
prove native interpolation/frame pacing. Add the narrowest dependency-level native
test if the dependency's existing test infrastructure supports it. Otherwise, record
the manual native matrix explicitly rather than claiming Jest covers it.

## Persisting a dependency fix

Edit the installed dependency only to develop the patch. From `expo/`, regenerate
only the dependency that changed:

```sh
npx patch-package react-native-macos
# or, for the zoom recognizer:
npx patch-package react-native-gesture-handler
```

Then review the entire regenerated patch. It must contain only the intentional
dependency-boundary change and preserve the existing lifecycle/Command-wheel fixes.
Do not hand-edit `package-lock.json` or regenerate both patches when one dependency
changed.

Verify patch-package's application check rather than treating the current
`node_modules` contents as proof:

```sh
npm run postinstall
```

An already-patched `node_modules` tree is not a clean-reapplication proof. Before
final completion, also apply the generated patch in a disposable fresh install or CI
checkout that contains the complete candidate diff. Do not wipe this dirty worktree
to manufacture that check.

## Validation gate after a code change

Native dependency patches require a macOS native rebuild; Metro reload is not enough.
Run commands from the worktree root unless a block begins with `cd expo`.

### Automated checks

```sh
cd expo
npm run postinstall
npm test -- --runTestsByPath \
  src/features/app/components/AppDrawer.test.tsx \
  src/features/app/components/AppDrawerLayout.test.tsx \
  src/features/app/components/AppScreenContent.macos.test.tsx \
  src/features/app/screens/ChatScreen.autoRecordingPanel.test.tsx \
  src/features/app/screens/SkiaMiniBoardScreen.test.tsx \
  --runInBand
npm run typecheck
npm run typecheck:macos
```

Build macOS Debug arm64 without signing. Keep derived data outside the repository so
the dirty-worktree review stays readable:

```sh
cd expo
xcodebuild \
  -workspace macos/bitty.xcworkspace \
  -scheme bitty-macOS \
  -configuration Debug \
  -sdk macosx \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/bitty-macos-smooth-scroll-derived-data \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build
```

Run `git diff --check` from the worktree root and inspect `git status --short` so an
untracked audit document is not omitted from the review.

### Manual macOS matrix

Use both a traditional mouse and a trackpad. Record device, build configuration, and
result rather than writing only "manual check passed."

Ordinary scrolling:

- Drawer, Chat, and Current Settings move smoothly without changing relative
  sensitivity unexpectedly.
- Precise trackpad momentum is unchanged; discrete-wheel shaping does not delay it.
- Vertical/horizontal movement, Shift + wheel, natural scrolling on/off, nested
  scrolling at both bounds, scroll-bar dragging, keyboard scrolling, and Reduce
  Motion remain usable.
- Chat stays at the user's reading position during streamed output and Markdown
  remeasurement, then resumes follow only under its existing rules.

Skia Command + wheel:

- direction and sensitivity are correct on both devices;
- the point beneath the cursor remains stable throughout intermediate frames;
- an empty and heavily populated board both behave correctly;
- scale stops at `0.25`/`2.5` and reverses immediately away from either bound;
- Command release, gesture cancel, focus loss, screen change, and unmount leave no
  residual zoom;
- an ordinary wheel over the board does not change the board transform, is not
  consumed as pinch, and returns to the normal responder chain;
- trackpad momentum does not leak into ordinary scrolling after Command release.

Finally verify on iPhone that ordinary scrolling and native pinch zoom are unchanged.
This is required because shared JS consumers remain in the path even though the new
native code is macOS-guarded. Use the existing iOS project on an available simulator
or attached device; the interactive selector avoids hard-coding local device names:

```sh
cd expo
npx expo run:ios --device
```

### Acceptance criteria

The task is complete only when:

- the measured cause and selected owner match the decision table;
- precise trackpad event/momentum behavior is preserved unless a measured defect was
  explicitly corrected;
- discrete wheel changes are visibly distributed without residual motion, drift, or
  broken nested scrolling;
- the automated checks, Debug native build, macOS matrix, and iPhone regression check
  are recorded against the resulting diff;
- temporary diagnostics are removed and the matching patch cleanly reapplies;
- the user accepts the remaining subjective scrolling and zoom feel.

Do not mark optimized frame pacing verified while Release/Profile is blocked.

## Previous Release blocker

The audit-remediation diff restores the Expo-era `react-native-enriched-markdown`
version and disables unused Math support in the Expo plugin configuration. This is
intended to remove the earlier `BOOL`-to-`bool` Release error without a dependency
source patch. A successful Release/Profile build must still be recorded before using
optimized frame-pacing results.

## Documentation-only check

For a documentation-only edit, do not run code tests or native builds. The handoff
documents are tracked, so run:

```sh
git diff --check
```
