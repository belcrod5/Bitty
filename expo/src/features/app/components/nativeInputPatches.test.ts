import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gesturePatch = readFileSync(
  resolve(__dirname, "../../../../patches/react-native-gesture-handler+2.28.0.patch"),
  "utf8"
);
const macOSPatch = readFileSync(
  resolve(__dirname, "../../../../patches/react-native-macos+0.81.9.patch"),
  "utf8"
);
const enrichedMarkdownPatch = readFileSync(
  resolve(__dirname, "../../../../patches/react-native-enriched-markdown+0.5.0.patch"),
  "utf8"
);

test("react-native-macos forwards Fabric submit key combinations to TextInput traits", () => {
  expect(macOSPatch).toContain('traits.submitKeyEvents = convertRawProp(');
  expect(macOSPatch).toContain('"submitKeyEvents",');
  expect(macOSPatch).toContain('sourceTraits.submitKeyEvents,');
  expect(macOSPatch).toContain('defaultTraits.submitKeyEvents);');
});

test("react-native-macos submits Command+Enter after committing marked IME text", () => {
  const textViewPatchStart = macOSPatch.indexOf(
    "diff --git a/node_modules/react-native-macos/Libraries/Text/TextInput/Multiline/RCTUITextView.mm"
  );
  const textViewPatch = macOSPatch.slice(textViewPatchStart);

  expect(textViewPatchStart).toBeGreaterThanOrEqual(0);
  expect(textViewPatch).toContain("if (self.hasMarkedText)");
  expect(textViewPatch).toContain("[super keyDown:event];");
  expect(textViewPatch).toContain(
    "!self.hasMarkedText && (event.modifierFlags & NSEventModifierFlagCommand)"
  );
  expect(textViewPatch).toContain("[self.textInputDelegate submitOnKeyDownIfNeeded:event];");
  expect(textViewPatch.indexOf("[super keyDown:event];")).toBeLessThan(
    textViewPatch.indexOf("[self.textInputDelegate submitOnKeyDownIfNeeded:event];")
  );
});

test("react-native-macos leaves key equivalents native without a TextInput delegate", () => {
  const textViewPatchStart = macOSPatch.indexOf(
    "diff --git a/node_modules/react-native-macos/Libraries/Text/TextInput/Multiline/RCTUITextView.mm"
  );
  const nextPatchStart = macOSPatch.indexOf("\ndiff --git ", textViewPatchStart + 1);
  const textViewPatch = macOSPatch.slice(textViewPatchStart, nextPatchStart);

  expect(textViewPatchStart).toBeGreaterThanOrEqual(0);
  expect(nextPatchStart).toBeGreaterThan(textViewPatchStart);
  expect(textViewPatch).toContain(
    "+  id<RCTBackedTextInputDelegate> textInputDelegate = self.textInputDelegate;"
  );
  expect(textViewPatch).toContain(
    "+  if (textInputDelegate && self.window.firstResponder == self && !self.hasMarkedText && ![textInputDelegate textInputShouldHandleKeyEvent:event]) {"
  );
  expect(textViewPatch).toContain("   return [super performKeyEquivalent:event];");
});

test("react-native-macos keeps upstream click dispatch (child-click fallback withdrawn)", () => {
  // 子ビュークリックはresponder経路が正常に処理する(実測確認済み)。かつての
  // targetIsDescendantフォールバックはonPress二重発火の原因だったため撤回した。
  // このパッチに再導入されないことを保証する。
  expect(macOSPatch).not.toContain("targetIsDescendant");
  expect(macOSPatch).not.toContain("shouldHandleMacOSChildPointerClick");
  expect(macOSPatch).not.toContain("_lastResponderOnPressTime");
});

test("macOS tap gestures do not forward right clicks", () => {
  const tapPatchStart = gesturePatch.indexOf(
    "diff --git a/node_modules/react-native-gesture-handler/apple/Handlers/RNTapHandler.m"
  );
  const tapPatch = gesturePatch.slice(tapPatchStart);

  expect(tapPatchStart).toBeGreaterThanOrEqual(0);
  expect(tapPatch).toContain("-- (void)rightMouseDown:(NSEvent *)event");
  expect(tapPatch).toContain("-- (void)rightMouseDragged:(NSEvent *)event");
  expect(tapPatch).toContain("-- (void)rightMouseUp:(NSEvent *)event");
  expect(tapPatch).not.toContain("+- (void)rightMouseDown:(NSEvent *)event");
  expect(tapPatch).not.toContain("+- (void)rightMouseDragged:(NSEvent *)event");
  expect(tapPatch).not.toContain("+- (void)rightMouseUp:(NSEvent *)event");
  expect(tapPatch).toContain("-  [self interactionsBegan:[NSSet setWithObject:event] withEvent:event];");
  expect(tapPatch).toContain("-  [self interactionsMoved:[NSSet setWithObject:event] withEvent:event];");
  expect(tapPatch).toContain("-  [self interactionsEnded:[NSSet setWithObject:event] withEvent:event];");
});

test("macOS right-click long press keeps drag cancellation active", () => {
  expect(gesturePatch).toContain(
    "if (block == nil && self.state != NSGestureRecognizerStateChanged)"
  );
  expect(gesturePatch).toContain("- (void)rightMouseDragged:(NSEvent *)event");
  expect(gesturePatch).toContain("- (void)rightMouseUp:(NSEvent *)event");
  expect(gesturePatch).toContain("if ([self shouldCancelGesture])");
  expect(gesturePatch).toContain("NSGestureRecognizerStateCancelled");
});

test("macOS markdown uses native mouse selection and context-menu behavior", () => {
  const textViewPatchStart = enrichedMarkdownPatch.indexOf(
    "diff --git a/node_modules/react-native-enriched-markdown/ios/views/ENRMContextMenuTextView+macOS.m"
  );
  const textViewPatch = enrichedMarkdownPatch.slice(textViewPatchStart);

  expect(textViewPatchStart).toBeGreaterThanOrEqual(0);
  expect(textViewPatch).toContain("+        if (tv != self && tv.selectedRange.length > 0)");
  expect(textViewPatch).toContain("-      [menu popUpMenuPositioningItem:nil");
  expect(textViewPatch).not.toContain("+      [menu popUpMenuPositioningItem:nil");
  expect(textViewPatch).toContain("\n   [super rightMouseDown:event];");
  expect(textViewPatch).toContain("-- (void)menuDidClose:(NSMenu *)menu");
  expect(textViewPatch).toContain("-    self.selectedRange = NSMakeRange(0, 0);");
  expect(textViewPatch).not.toContain("+    self.selectedRange = NSMakeRange(0, 0);");
});

test("macOS wheel zoom accepts only supported vertical input", () => {
  expect(gesturePatch).toContain("BOOL hasVerticalDelta = fabs(delta) > 0.0001;");
  expect(gesturePatch).toContain(
    "BOOL commandPressed = (event.modifierFlags & NSEventModifierFlagCommand) != 0;"
  );
  expect(gesturePatch).toContain(
    "BOOL acceptsWheel = hasVerticalDelta && (!event.hasPreciseScrollingDeltas || commandPressed);"
  );
  expect(gesturePatch).toContain("if (!acceptsWheel || !self.enabled || ![self isEventInsideView:event])");
});

test("macOS wheel zoom owns active terminal phases before filtering deltas", () => {
  const terminalGuard = gesturePatch.indexOf("if (_commandWheelActive && ended)");
  const acceptsGate = gesturePatch.indexOf(
    "if (!acceptsWheel || !self.enabled || ![self isEventInsideView:event])"
  );

  expect(terminalGuard).toBeGreaterThanOrEqual(0);
  expect(terminalGuard).toBeLessThan(acceptsGate);
  expect(gesturePatch).toContain(
    "BOOL cancelled = (phase & NSEventPhaseCancelled) != 0;"
  );
  expect(gesturePatch).toContain(
    "BOOL ended = cancelled || (phase & NSEventPhaseEnded) != 0;"
  );
  expect(gesturePatch).toContain("if (!cancelled && hasVerticalDelta)");
  expect(gesturePatch).toContain(`if (_commandWheelActive && ended) {
+    if (!cancelled && hasVerticalDelta) {
+      [self updateCommandWheelWithEvent:event delta:delta];
+    }
+    [self finishCommandWheelWithEvent:event cancelled:cancelled];
+    return YES;
+  }`);
});
