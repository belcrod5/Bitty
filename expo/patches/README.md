# Local dependency patches

`react-native-macos+0.81.9.patch` keeps Fabric scroll interactions bracketed for
React Native, smooths phase-less mouse-wheel ticks, and doubles only their
vertical distance. Precise trackpad and horizontal scrolling remain native. It
also maps a macOS secondary click to Pressability's existing `onLongPress`
contract immediately without emitting primary-button press feedback or changing
primary-button and mobile timing. JS press dispatch stays upstream: mouse
clicks (including clicks on text and icon descendants) are handled once by the
responder path, and Pressability's `onClick` keeps ignoring pointer-typed click
events. A previous revision added a `targetIsDescendant` fallback that re-fired
`onPress` from `onClick`; real-device tracing showed the responder path already
handles descendant clicks, and the fallback caused a double `onPress`, so it was
withdrawn — do not reintroduce it. The patch also restores
Fabric's missing `submitKeyEvents` prop
conversion so multiline inputs can use Command+Enter without changing plain
Enter into submit. If Command+Enter is pressed while an IME composition is
active, the native text view commits the marked text before running that same
submit-key matcher, so the first shortcut sends the finalized text.

Fabric `RCTViewComponentView` now consumes native `mouseDown` without calling
super. `RCTSurfaceTouchHandler` already handles the React Native press lifecycle;
AppKit's default mouse forwarding can also deliver that same event to an
underlapping sibling, bypassing the initial hit test (see
[Apple TN3212](https://developer.apple.com/documentation/technotes/tn3212-adopting-gesture-recognizers-for-sidecar-touch-support)).
Traces showed foreground labels forwarding into the background composer or
Markdown text view, followed by a cancelled RN touch without `mouseUp`.
Stopping that forwarding at the Fabric view boundary keeps background text
from entering its selection tracking loop. Native text descendants and
selectable paragraphs retain their own `mouseDown` implementations. No changes
to gesture arbitration or JS press dispatch are needed. Validate overlay clicks,
text selection, composer focus/editing, and native window dragging on macOS.

`react-native-gesture-handler+2.28.0.patch` maps an unmodified, discrete vertical
macOS wheel over a pinch target into the existing pinch lifecycle, so the Skia
board keeps one zoom-transform owner. Precise trackpad scrolling still requires
Command, and horizontal scrolling passes through. The patch also activates macOS
LongPress gestures immediately on a secondary click while preserving drag
cancellation, while Tap gestures no longer receive that secondary click. Native
pinch, tap, and touch long presses on iOS remain unchanged.

`react-native-enriched-markdown+0.5.0.patch` casts Objective-C `BOOL` values to
C++ `bool` in event-emitter payload initializers. The macOS SDK treats the
implicit narrowing as a compile error (`-Wc++11-narrowing`), which breaks the
Release build. Behavior is unchanged; remove the patch once upstream builds
cleanly for macOS.

`expo-secure-store+15.0.8.patch` adds macOS pod support and uses a String
Keychain account on macOS. It migrates the previous account-less items only
when no canonical item exists; if both exist, the canonical value wins. The
macOS migration is exercised against the real Security API by
`scripts/test-secure-store-macos.sh`. iOS keeps Expo's original Data account
behavior. Remove the patch after Expo ships equivalent macOS support and
migration.

`expo-modules-core+3.0.30.patch` keeps Expo's app-private document directory out
of the user's protected `~/Documents` folder on macOS. Expo Modules Core otherwise
uses that shared folder as the default app context, which makes unsigned builds
subject to macOS Files and Folders privacy denial. The macOS default is now the
bundle identifier directory under Application Support. Existing CFBundleName
directories are copied through a temporary sibling before becoming canonical;
the source is never deleted. iOS behavior is unchanged. Recheck the patch when
Expo Modules Core changes and remove it after upstream provides a macOS-safe
app-private default.

`react-native+0.81.6.patch` fixes the iOS Fabric responder state corruption
reported in [Shopify/react-native-skia #4006](https://github.com/Shopify/react-native-skia/issues/4006).
A batched touch cancel can end multiple touches in one event, but React Native's
responder plugin adjusted `trackedTouchCount` by only one. The patch synchronizes
that count with the event's authoritative `touches.length` in every Fabric bundle.

The patch targets React Native 0.81.6. No React Native upstream issue has been
opened yet. The reproduction is tested with React Native Skia 2.11.1, which this
repository now uses. When either React Native or Skia changes, check upstream
again and rerun the keyboard-open first-tap scenario on a real device. Remove
the patch only after the same fix ships upstream and that scenario passes.

The install version guard keeps Skia at the investigated 2.11.1 version.
When intentionally upgrading Skia, update the guard only after checking for an
upstream fix and scheduling the same real-device scenario for revalidation.
