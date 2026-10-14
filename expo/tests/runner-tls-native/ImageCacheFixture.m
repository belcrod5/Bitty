#import "ENRMImageAttachment.h"

// The production downloader performs real TLS requests and AppKit image decoding.
// Only its rendering-owned memory cache and RN UIKit alias are supplied here.
@implementation NativeTestImage
- (CGImageRef)CGImage { return [self CGImageForProposedRect:NULL context:nil hints:nil]; }
@end
@implementation ENRMImageAttachment
+ (NSCache *)originalImageCache {
  static NSCache *cache;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cache = [NSCache new]; });
  return cache;
}
@end
