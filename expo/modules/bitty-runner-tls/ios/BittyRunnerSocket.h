#import <Foundation/Foundation.h>

@interface BittyRunnerSocket : NSObject <NSURLSessionWebSocketDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionWebSocketTask *task;
@property(nonatomic, copy) void (^emit)(NSDictionary *event);
@property(nonatomic, assign) BOOL terminal;
- (void)receive;
- (void)finishCode:(NSInteger)code reason:(NSString *)reason error:(BOOL)error;
@end
