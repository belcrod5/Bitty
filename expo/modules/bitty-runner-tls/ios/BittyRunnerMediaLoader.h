#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface BittyRunnerMediaLoader : NSObject <AVAssetResourceLoaderDelegate, NSURLSessionDataDelegate>
+ (void)attachToAsset:(AVURLAsset *)asset headers:(NSDictionary<NSString *, NSString *> *)headers;
@end
NS_ASSUME_NONNULL_END
