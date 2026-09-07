#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <React/RCTUITextField.h>
#import <React/RCTUISecureTextField.h>
#import <React/RCTTouchHandler.h>
#import <React/RCTUtils.h>

// These unrelated dependencies are not exercised by the editor regression test.
CGFloat RCTCeilPixelValue(CGFloat value) { return ceil(value); }
@implementation RCTTouchHandler
+ (instancetype)touchHandlerForView:(NSView *)view { return nil; }
@end

@interface InputDelegate : NSObject <RCTBackedTextInputDelegate>
@property NSUInteger changes;
@property NSUInteger begins;
@end
@implementation InputDelegate
- (BOOL)textInputShouldBeginEditing { return YES; }
- (void)textInputDidBeginEditing { self.begins++; }
- (BOOL)textInputShouldEndEditing { return YES; }
- (void)textInputDidEndEditing {}
- (NSString *)textInputShouldChangeText:(NSString *)text inRange:(NSRange)range { return text; }
- (void)textInputDidChange { self.changes++; }
- (void)textInputDidChangeSelection {}
- (BOOL)textInputShouldHandleKeyEvent:(NSEvent *)event { return YES; }
- (BOOL)textInputShouldHandlePaste:(id<RCTBackedTextInputViewProtocol>)sender { return YES; }
@end

static void Check(BOOL condition, NSString *message)
{
  if (!condition) {
    @throw [NSException exceptionWithName:@"TestFailure" reason:message userInfo:nil];
  }
}

static void DrawEditor(NSTextView *editor)
{
  [editor setNeedsDisplay:YES];
  [editor displayIfNeeded];
  NSBitmapImageRep *bitmap = [editor bitmapImageRepForCachingDisplayInRect:editor.bounds];
  Check(bitmap != nil, @"The field editor must be drawable");
  [editor cacheDisplayInRect:editor.bounds toBitmapImageRep:bitmap];
}

int main(void)
{
  @autoreleasepool {
    @try {
      [NSApplication sharedApplication];
      Check(class_getSuperclass(RCTUISecureTextField.class) == NSSecureTextField.class,
            @"Secure control must really inherit NSSecureTextField");
      Check(class_getSuperclass(RCTUITextField.class) == NSTextField.class,
            @"Plain control must retain NSTextField behavior");
      NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 500, 160)
                                                   styleMask:NSWindowStyleMaskTitled
                                                     backing:NSBackingStoreBuffered defer:NO];
      window.releasedWhenClosed = NO;
      [window makeKeyAndOrderFront:nil];
      for (Class fieldClass in @[RCTUISecureTextField.class, RCTUITextField.class]) {
        NSTextField<RCTBackedTextInputViewProtocol> *field = [[fieldClass alloc] initWithFrame:NSMakeRect(20, 50, 420, 40)];
        BOOL secure = fieldClass == RCTUISecureTextField.class;
        Check([field.cell isKindOfClass:NSSecureTextFieldCell.class] == secure, @"Native cell security must match the control");
        InputDelegate *delegate = [InputDelegate new];
        field.textInputDelegate = delegate;
        field.defaultTextAttributes = @{NSFontAttributeName: [NSFont systemFontOfSize:16]};
        field.textContainerInset = NSEdgeInsetsMake(2, 3, 2, 3);
        [window.contentView addSubview:field];
        for (NSUInteger pass = 0; pass < 3; pass++) {
          NSPoint clickPoint = [field convertPoint:NSMakePoint(20, 20) toView:nil];
          NSEvent *mouseDown = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
                                               location:clickPoint modifierFlags:0 timestamp:0
                                           windowNumber:window.windowNumber context:nil
                                            eventNumber:1 clickCount:1 pressure:1];
          NSEvent *mouseUp = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp
                                             location:clickPoint modifierFlags:0 timestamp:0
                                         windowNumber:window.windowNumber context:nil
                                          eventNumber:2 clickCount:1 pressure:0];
          // AppKit's mouse-down tracking loop consumes the queued release event.
          [NSApp postEvent:mouseUp atStart:YES];
          [window sendEvent:mouseDown];
          NSTextView *editor = (NSTextView *)field.currentEditor;
          Check(editor != nil && editor.delegate == (id)field, @"AppKit must connect the editor delegate");
          DrawEditor(editor); // Draw after mouse focus to check the field editor remains usable.
          NSUInteger changes = delegate.changes;
          [editor insertText:@"typed-test-value" replacementRange:NSMakeRange(0, editor.string.length)];
          Check(delegate.changes > changes, @"Typing must reach the React delegate adapter");
          Check([field.stringValue isEqualToString:@"typed-test-value"], @"Typing must update the native value");
          DrawEditor(editor);

          // Use a private pasteboard, so the user's clipboard is never read or modified.
          NSPasteboard *pasteboard = [NSPasteboard pasteboardWithUniqueName];
          [pasteboard declareTypes:@[NSPasteboardTypeString] owner:nil];
          Check([pasteboard setString:@"pasted-test-value" forType:NSPasteboardTypeString], @"Test pasteboard must accept synthetic text");
          [editor setSelectedRange:NSMakeRange(0, editor.string.length)];
          changes = delegate.changes;
          Check([editor readSelectionFromPasteboard:pasteboard type:NSPasteboardTypeString], @"Pasted text must be accepted");
          [pasteboard releaseGlobally];
          Check(delegate.changes > changes, @"Pasting must reach the React delegate adapter");
          Check([field.stringValue isEqualToString:@"pasted-test-value"], @"Pasting must update the native value");
          DrawEditor(editor);
          Check([window makeFirstResponder:nil], @"Field must release focus");
        }
        Check(delegate.begins == 3, @"Repeated focus must reach the React delegate adapter");
        [field removeFromSuperview];
      }
      [window close];
      puts("PASS: native secure/plain mouse focus, drawing, typing, paste, and React delegate events (3 cycles each)");
      return 0;
    } @catch (NSException *exception) {
      fprintf(stderr, "FAIL: %s: %s\n", exception.name.UTF8String, exception.reason.UTF8String);
      return 1;
    }
  }
}
