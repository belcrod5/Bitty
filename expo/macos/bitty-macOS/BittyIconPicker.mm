#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <React/RCTBridgeModule.h>

@interface BittyIconPicker : NSObject <RCTBridgeModule>
@end

@implementation BittyIconPicker

RCT_EXPORT_MODULE(BittyIconPicker)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_REMAP_METHOD(pick, pickWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.allowedContentTypes = @[ UTTypeImage ];
  panel.canChooseDirectories = NO;
  panel.canChooseFiles = YES;
  panel.allowsMultipleSelection = NO;
  [panel beginWithCompletionHandler:^(NSModalResponse response) {
    if (response != NSModalResponseOK || !panel.URL) {
      resolve(nil);
      return;
    }
    NSImage *image = [[NSImage alloc] initWithContentsOfURL:panel.URL];
    if (!image || image.size.width <= 0 || image.size.height <= 0) {
      reject(@"invalid_image", @"画像を開けません。", nil);
      return;
    }
    CGFloat scale = MIN(1.0, 256.0 / MAX(image.size.width, image.size.height));
    NSInteger width = MAX(1, (NSInteger)round(image.size.width * scale));
    NSInteger height = MAX(1, (NSInteger)round(image.size.height * scale));
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
      pixelsWide:width pixelsHigh:height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
      isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    if (!bitmap) {
      reject(@"invalid_image", @"画像を変換できません。", nil);
      return;
    }
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    [image drawInRect:NSMakeRect(0, 0, width, height) fromRect:NSZeroRect
      operation:NSCompositingOperationCopy fraction:1.0];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png || png.length > 1024 * 1024) {
      reject(@"invalid_image", @"画像を変換できません。", nil);
      return;
    }
    resolve([@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]]);
  }];
}

@end
