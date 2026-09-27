#import <AppKit/AppKit.h>
#import <React/RCTViewManager.h>

@interface BittyVoiceBlurManager : RCTViewManager
@end

@implementation BittyVoiceBlurManager

RCT_EXPORT_MODULE(BittyVoiceBlur)

+ (BOOL)requiresMainQueueSetup { return YES; }

- (NSView *)view
{
  NSVisualEffectView *view = [NSVisualEffectView new];
  view.blendingMode = NSVisualEffectBlendingModeWithinWindow;
  view.material = NSVisualEffectMaterialFullScreenUI;
  view.state = NSVisualEffectStateActive;
  return view;
}

@end
