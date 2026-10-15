#import <AppKit/AppKit.h>
#import <QuartzCore/CADisplayLink.h>
#import "RCTEnhancedScrollView.h"

@interface RCTEnhancedScrollView (AnimationTest)
- (void)stepDiscreteScrollAnimation:(CADisplayLink *)displayLink;
- (void)stopDiscreteScrollAnimation;
@end

@interface TestFrame : NSObject
@property CFTimeInterval timestamp;
@end
@implementation TestFrame
@end

@interface FlippedDocument : NSView
@end
@implementation FlippedDocument
- (BOOL)isFlipped { return YES; }
@end

static void Check(BOOL condition, NSString *message)
{
  if (!condition) {
    @throw [NSException exceptionWithName:@"TestFailure" reason:message userInfo:nil];
  }
}

static void CheckOffset(RCTEnhancedScrollView *scroll, CGPoint expected, NSString *message)
{
  CGPoint actual = scroll.contentOffset;
  Check(fabs(actual.x - expected.x) < 0.01 && fabs(actual.y - expected.y) < 0.01,
        [NSString stringWithFormat:@"%@: expected %@, got %@", message,
                                   NSStringFromPoint(expected), NSStringFromPoint(actual)]);
}

static void Wheel(RCTEnhancedScrollView *scroll, int deltaX, int deltaY)
{
  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, deltaY, deltaX);
  NSEvent *wheel = [NSEvent eventWithCGEvent:event];
  Check(!wheel.hasPreciseScrollingDeltas && wheel.phase == NSEventPhaseNone &&
            wheel.momentumPhase == NSEventPhaseNone, @"Test must exercise the discrete wheel path");
  [scroll scrollWheel:wheel];
  CFRelease(event);
}

static void Step(RCTEnhancedScrollView *scroll, double progress)
{
  TestFrame *frame = [TestFrame new];
  frame.timestamp = [[scroll valueForKey:@"discreteScrollStartTimestamp"] doubleValue] + 0.12 * progress;
  [scroll stepDiscreteScrollAnimation:(CADisplayLink *)frame];
}

int main(void)
{
  @autoreleasepool {
    @try {
      [NSApplication sharedApplication];
      NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 400)
                                                   styleMask:NSWindowStyleMaskTitled
                                                     backing:NSBackingStoreBuffered defer:NO];
      window.releasedWhenClosed = NO;
      RCTEnhancedScrollView *scroll = [[RCTEnhancedScrollView alloc] initWithFrame:NSMakeRect(0, 0, 400, 400)];
      scroll.documentView = [[FlippedDocument alloc] initWithFrame:NSMakeRect(0, 0, 4000, 4000)];
      scroll.horizontalLineScroll = 10;
      scroll.verticalLineScroll = 10;
      window.contentView = scroll;

      NSUInteger cases = 0;
      for (NSNumber *horizontal in @[@NO, @YES]) {
        for (NSNumber *direction in @[@(-1), @1]) {
          for (NSNumber *correction in @[@(-120), @120]) {
            [scroll stopDiscreteScrollAnimation];
            scroll.contentOffset = CGPointMake(1000, 1000);
            int wheelX = horizontal.boolValue ? direction.intValue : 0;
            int wheelY = horizontal.boolValue ? 0 : direction.intValue;
            Wheel(scroll, wheelX, wheelY);
            Step(scroll, 0.25);
            CGPoint before = scroll.contentOffset;
            CheckOffset(scroll, CGPointMake(1000 - wheelX * 10 * 0.578125,
                                            1000 - wheelY * 20 * 0.578125),
                        @"Uncorrected scrolling must retain the existing easing and distance");
            // Fabric MVCP writes an offset correction after items above/left
            // change size. Also cover AppKit moving clip bounds directly.
            CGPoint shift = horizontal.boolValue ? CGPointMake(correction.doubleValue, 0)
                                                : CGPointMake(0, correction.doubleValue);
            CGPoint corrected = CGPointMake(before.x + shift.x, before.y + shift.y);
            scroll.contentOffset = corrected;
            Step(scroll, 0.25);
            CheckOffset(scroll, corrected, @"A frame with no elapsed time must preserve the layout correction");
            [scroll.contentView scrollToPoint:CGPointMake(corrected.x + shift.x, corrected.y + shift.y)];
            [scroll reflectScrolledClipView:scroll.contentView];
            Step(scroll, 1);
            CGPoint expected = CGPointMake(1000 + 2 * shift.x - wheelX * 10,
                                           1000 + 2 * shift.y - wheelY * 20);
            CheckOffset(scroll, expected, @"Animation must finish in the corrected coordinate space");
            cases++;
          }
          for (NSNumber *reverse in @[@NO, @YES]) {
            [scroll stopDiscreteScrollAnimation];
            scroll.contentOffset = CGPointMake(1000, 1000);
            int wheelX = horizontal.boolValue ? direction.intValue : 0;
            int wheelY = horizontal.boolValue ? 0 : direction.intValue;
            Wheel(scroll, wheelX, wheelY);
            Step(scroll, 0.25);
            CGPoint before = scroll.contentOffset;
            CGPoint corrected = CGPointMake(before.x + 120, before.y + 120);
            scroll.contentOffset = corrected;
            int nextX = reverse.boolValue ? -wheelX : wheelX;
            int nextY = reverse.boolValue ? -wheelY : wheelY;
            Wheel(scroll, nextX, nextY);
            Step(scroll, 1);
            CGPoint expected = reverse.boolValue
                ? CGPointMake(corrected.x - nextX * 10, corrected.y - nextY * 20)
                : CGPointMake(1120 - wheelX * 20, 1120 - wheelY * 40);
            CheckOffset(scroll, expected, @"New wheel input must accumulate or reverse in the corrected coordinate space");
            cases++;
          }
        }
      }
      [window close];
      printf("PASS: %lu native scroll animation correction cases\n", (unsigned long)cases);
      return 0;
    } @catch (NSException *exception) {
      fprintf(stderr, "FAIL: %s\n", exception.reason.UTF8String);
      return 1;
    }
  }
}
