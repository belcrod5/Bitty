#import <Foundation/Foundation.h>
#import <Security/Security.h>

NS_ASSUME_NONNULL_BEGIN
// One paired origin and CA are shared by HTTP, WebSockets, STT, push and media.
@interface BittyRunnerTLS : NSObject <NSURLSessionDelegate, NSURLSessionTaskDelegate>
+ (instancetype)shared NS_SWIFT_NAME(shared());
+ (void)install;
- (BOOL)configureOrigin:(NSString *)origin certificate:(NSString *)certificate error:(NSError **)error;
- (BOOL)handlesURL:(NSURL *)url NS_SWIFT_NAME(handlesURL(_:));
- (BOOL)evaluateTrust:(SecTrustRef)trust host:(NSString *)host port:(NSInteger)port;
- (NSURLSession *)sessionWithDelegate:(nullable id<NSURLSessionDelegate>)delegate queue:(nullable NSOperationQueue *)queue NS_SWIFT_NAME(session(withDelegate:queue:));
- (void)handleChallenge:(NSURLAuthenticationChallenge *)challenge
             completion:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *_Nullable))completion NS_SWIFT_NAME(handle(_:completion:));
- (NSURL *)mediaURL:(NSURL *)url headers:(NSDictionary<NSString *, NSString *> *)headers;
- (void)logMediaStage:(NSString *)stage request:(NSURLRequest *)request
            response:(nullable NSURLResponse *)response error:(nullable NSError *)error;
@end
NS_ASSUME_NONNULL_END
