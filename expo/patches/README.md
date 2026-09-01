# Local dependency patches

`expo-secure-store+15.0.8.patch` adds macOS pod support and uses a String
Keychain account on macOS. It migrates the previous account-less items only
when no canonical item exists; if both exist, the canonical value wins. iOS
keeps Expo's original Data account behavior. Remove the patch after Expo ships
equivalent macOS support and migration.

`expo-modules-core+3.0.30.patch` keeps Expo's app-private document directory out
of the user's protected `~/Documents` folder on macOS. Expo Modules Core otherwise
uses that shared folder as the default app context, which makes unsigned builds
subject to macOS Files and Folders privacy denial. The macOS default is now the
app's directory under Application Support; iOS behavior is unchanged. Recheck the
patch when Expo Modules Core changes and remove it after upstream provides a
macOS-safe app-private default.

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
