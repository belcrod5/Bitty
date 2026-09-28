#import <AppKit/AppKit.h>
#import <React/RCTViewManager.h>

@interface BittyVoiceBlurManager : RCTViewManager
@end

@implementation BittyVoiceBlurManager

RCT_EXPORT_MODULE(BittyVoiceBlur)

+ (BOOL)requiresMainQueueSetup { return YES; }

- (NSView *)view
{
  NSView *container = [super view];
  NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:container.bounds];
  effect.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  effect.blendingMode = NSVisualEffectBlendingModeWithinWindow;
  effect.material = NSVisualEffectMaterialFullScreenUI;
  effect.state = NSVisualEffectStateActive;
  [container addSubview:effect];
  return container;
}

@end
