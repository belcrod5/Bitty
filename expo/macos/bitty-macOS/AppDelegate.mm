#import "AppDelegate.h"

#import <React/RCTBridge.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <ReactCommon/RCTHost.h>

@interface AppDelegate ()

@property (nonatomic, strong) id chatFindKeyMonitor;

@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"main";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];

  [super applicationDidFinishLaunching:notification];
  self.window.releasedWhenClosed = NO;

  __weak AppDelegate *weakSelf = self;
  self.chatFindKeyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                                   handler:^NSEvent *(NSEvent *event) {
    NSEventModifierFlags modifiers = event.modifierFlags &
      (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift);
    if (event.keyCode == 53 && modifiers == 0) {
      [weakSelf emitDeviceEvent:@"bittyChatFindCancelRequested"];
    }
    return event;
  }];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

- (IBAction)openChatFind:(id)sender
{
  [self emitDeviceEvent:@"bittyChatFindRequested"];
}

- (void)emitDeviceEvent:(NSString *)eventName
{
  RCTHost *reactHost = self.rootViewFactory.reactHost;
  if (reactHost != nil) {
    [reactHost callFunctionOnJSModule:@"RCTDeviceEventEmitter"
                              method:@"emit"
                                args:@[ eventName ]];
    return;
  }

  [self.bridge enqueueJSCall:@"RCTDeviceEventEmitter"
                      method:@"emit"
                        args:@[ eventName ]
                  completion:NULL];
}

- (void)applicationWillTerminate:(NSNotification *)notification
{
  if (self.chatFindKeyMonitor != nil) {
    [NSEvent removeMonitor:self.chatFindKeyMonitor];
    self.chatFindKeyMonitor = nil;
  }
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)hasVisibleWindows
{
  if (!hasVisibleWindows) {
    [self.window makeKeyAndOrderFront:self];
  }
  return YES;
}

@end
