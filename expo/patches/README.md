# Local dependency patches

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
