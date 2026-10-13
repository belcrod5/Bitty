#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import "BittyRunnerTLS.h"
#import "BittyRunnerMediaLoader.h"
#import "BittyRunnerSocket.h"
// Minimal AVFoundation request fixtures drive the production incremental loader
// over actual TLS, including ranges AVAsset's tiny metadata fixture needn't ask for.
@interface TestMediaData : NSObject
@property(nonatomic) long long currentOffset;
@property(nonatomic) long long requestedOffset;
@property(nonatomic) NSInteger requestedLength;
@property(nonatomic) BOOL requestsAllDataToEndOfResource;
@property(nonatomic, strong) NSMutableData *received;
- (void)respondWithData:(NSData *)data;
@end
@implementation TestMediaData
- (void)respondWithData:(NSData *)data { [self.received appendData:data]; self.currentOffset += data.length; }
@end
@interface TestMediaInfo : NSObject
@property(nonatomic, copy) NSString *contentType;
@property(nonatomic) long long contentLength;
@property(nonatomic) BOOL byteRangeAccessSupported;
@end
@implementation TestMediaInfo
@end
@interface TestMediaLoading : NSObject
@property(nonatomic, strong) NSURLRequest *request;
@property(nonatomic, strong) TestMediaData *dataRequest;
@property(nonatomic, strong) TestMediaInfo *contentInformationRequest;
@property(nonatomic) BOOL isCancelled;
@property(nonatomic) BOOL isFinished;
@property(nonatomic, strong) NSError *error;
- (void)finishLoading;
- (void)finishLoadingWithError:(NSError *)error;
@end
@implementation TestMediaLoading
- (void)finishLoading { self.isFinished = YES; }
- (void)finishLoadingWithError:(NSError *)error { self.error = error; self.isFinished = YES; }
@end
static TestMediaLoading *mediaRequest(NSString *origin, NSString *path, NSInteger offset, NSInteger length) {
  TestMediaLoading *loading = [TestMediaLoading new];
  NSURL *url = [[BittyRunnerTLS shared] mediaURL:[NSURL URLWithString:[origin stringByAppendingString:path]]];
  loading.request = [NSURLRequest requestWithURL:url];
  loading.dataRequest = [TestMediaData new];
  loading.dataRequest.requestedOffset = offset;
  loading.dataRequest.requestedLength = length;
  loading.dataRequest.received = [NSMutableData new];
  loading.contentInformationRequest = [TestMediaInfo new];
  return loading;
}
static BOOL waitUntil(BOOL (^done)(void)) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6];
  while (!done() && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  return done();
}
static NSString *storagePath;
static NSURL *testConfigurationFile(id self, SEL selector) { return [NSURL fileURLWithPath:storagePath]; }
static NSError *fetch(NSURL *url, NSInteger *status, BOOL defaultSession) {
  __block BOOL done = NO;
  __block NSError *failure;
  __block NSInteger code = 0;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.timeoutInterval = 4;
  [request setValue:@"Bearer temporary-native-test-only" forHTTPHeaderField:@"Authorization"];
  [request setValue:@"temporary-test-only" forHTTPHeaderField:@"CF-Access-Client-Secret"];
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSMutableArray *protocols = [configuration.protocolClasses mutableCopy];
  [protocols insertObject:NSClassFromString(@"BittyRunnerProtocol") atIndex:0];
  configuration.protocolClasses = protocols;
  NSURLSession *session = defaultSession ? [NSURLSession sessionWithConfiguration:configuration] : [[BittyRunnerTLS shared] sessionWithDelegate:nil queue:nil];
  [[session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    failure = error;
    code = [(NSHTTPURLResponse *)response statusCode];
    done = YES;
  }] resume];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6];
  while (!done && [deadline timeIntervalSinceNow] > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  [session invalidateAndCancel];
  NSCAssert(done, @"Request timeout");
  *status = code;
  return failure;
}
static void check(BOOL condition, NSString *label) {
  if (!condition) { fprintf(stderr,"FAIL: %s\n",label.UTF8String); exit(1); }
  printf("PASS: %s\n",label.UTF8String);
}
int main(int argc, const char *argv[]) { @autoreleasepool {
  NSString *base = @(argv[1]);
  storagePath = [base stringByAppendingPathComponent:@"native-test-config.json"];
  Method method = class_getClassMethod(BittyRunnerTLS.class, NSSelectorFromString(@"configurationFile"));
  method_setImplementation(method, (IMP)testConfigurationFile);
  [BittyRunnerTLS install];
  NSDictionary *ports = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"ports.json"]] options:0 error:nil];
  NSString *origin = [NSString stringWithFormat:@"https://localhost:%@",ports[@"trusted"]];
  NSString *badOrigin = [NSString stringWithFormat:@"https://localhost:%@",ports[@"rogue"]];
  NSString *ca = [[NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"ca.der"]] base64EncodedStringWithOptions:0];
  NSInteger status;
  check(fetch([NSURL URLWithString:origin], &status, YES) != nil, @"Default HTTPS rejects unregistered private CA");
  NSError *configurationError;
  check([[BittyRunnerTLS shared] configureOrigin:origin certificate:ca error:&configurationError], @"QR CA configuration succeeds in isolated store");
  check(fetch([NSURL URLWithString:origin], &status, NO) == nil && status == 200, @"Shared TLS session authenticates paired HTTPS server");
  check(fetch([NSURL URLWithString:[origin stringByAppendingString:@"/protocol"]], &status, YES) == nil && status == 200, @"Explicit configuration protocol class covers URLSession");
  check(![[BittyRunnerTLS shared] handlesURL:[NSURL URLWithString:badOrigin]], @"Paired trust is restricted to its exact port");
  check(fetch([NSURL URLWithString:[origin stringByAppendingString:@"/redirect"]], &status, NO) == nil && status == 302, @"Redirect is not followed to another server");
  check([[BittyRunnerTLS shared] configureOrigin:badOrigin certificate:ca error:&configurationError], @"Pair test rogue endpoint with expected CA");
  check(fetch([NSURL URLWithString:badOrigin], &status, NO) != nil, @"Wrong CA server certificate is rejected");
  NSString *wrongName = [NSString stringWithFormat:@"https://127.0.0.1:%@",ports[@"trusted"]];
  check([[BittyRunnerTLS shared] configureOrigin:wrongName certificate:ca error:&configurationError], @"Set mismatched hostname test endpoint");
  check(fetch([NSURL URLWithString:wrongName], &status, NO) != nil, @"Wrong hostname is rejected even with paired CA");
  NSString *expiredOrigin = [NSString stringWithFormat:@"https://localhost:%@", ports[@"expired"]];
  check([[BittyRunnerTLS shared] configureOrigin:expiredOrigin certificate:ca error:&configurationError], @"Set expired leaf test endpoint");
  check(fetch([NSURL URLWithString:expiredOrigin], &status, NO) != nil, @"Expired server leaf is rejected");
  check(![[BittyRunnerTLS shared] configureOrigin:@"http://localhost:8788" certificate:ca error:&configurationError], @"Plain HTTP cannot become a paired TLS endpoint");
  check([[BittyRunnerTLS shared] configureOrigin:@"" certificate:@"" error:&configurationError], @"Clear pairing succeeds");
  check(fetch([NSURL URLWithString:origin], &status, YES) != nil, @"Default OS trust remains unchanged after clearing pairing");
  check([[BittyRunnerTLS shared] configureOrigin:origin certificate:ca error:&configurationError], @"Restore media test pairing");
  __block BOOL opened = NO, textReceived = NO, binaryReceived = NO, largeReceived = NO, closed = NO;
  BittyRunnerSocket *socket = [BittyRunnerSocket new];
  __weak BittyRunnerSocket *weakSocket = socket;
  socket.emit = ^(NSDictionary *event) {
    BittyRunnerSocket *socket = weakSocket;
    NSString *type = event[@"type"];
    if ([type isEqual:@"open"]) {
      opened = YES;
      [socket.task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:@"test echo"] completionHandler:^(NSError *error) {}];
    } else if ([type isEqual:@"message"]) {
      if ([event[@"binary"] boolValue]) {
        binaryReceived = [event[@"data"] isEqual:@"AAECAw=="];
        [socket.task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
        [socket finishCode:1000 reason:@"test complete" error:NO];
      } else {
        if ([event[@"data"] length] > 1024 * 1024) { largeReceived = YES; return; }
        textReceived = [event[@"data"] isEqual:@"test echo"];
        [socket.task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithData:[[NSData alloc] initWithBase64EncodedString:@"AAECAw==" options:0]] completionHandler:^(NSError *error) {}];
      }
    } else if ([type isEqual:@"close"]) closed = YES;
  };
  NSMutableURLRequest *websocketRequest = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:
      [[origin stringByReplacingOccurrencesOfString:@"https:" withString:@"wss:"] stringByAppendingString:@"/runner-ws"]]];
  [websocketRequest setValue:@"Bearer temporary-native-test-only" forHTTPHeaderField:@"Authorization"];
  socket.session = [[BittyRunnerTLS shared] sessionWithDelegate:socket queue:NSOperationQueue.mainQueue];
  socket.task = [socket.session webSocketTaskWithRequest:websocketRequest];
  [socket.task resume];
  NSDate *socketDeadline = [NSDate dateWithTimeIntervalSinceNow:8];
  while (!closed && socketDeadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  check(opened && textReceived, @"Production WebSocket receives text through paired TLS");
  check(binaryReceived, @"Production WebSocket receives binary frames through paired TLS");
  check(largeReceived, @"Production WebSocket preserves envelopes larger than one MiB");
  check(closed && socket.terminal, @"Production WebSocket cancellation closes its session");
  socket.emit = nil;
  NSURL *media = [[BittyRunnerTLS shared] mediaURL:[NSURL URLWithString:[origin stringByAppendingString:@"/test.mp4"]]];
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:media options:nil];
  [BittyRunnerMediaLoader attachToAsset:asset headers:@{@"Authorization":@"Bearer temporary-native-test-only",@"CF-Access-Client-Secret":@"temporary-test-only"}];
  __block BOOL mediaDone = NO;
  [asset loadValuesAsynchronouslyForKeys:@[@"playable",@"duration"] completionHandler:^{ mediaDone = YES; }];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
  while (!mediaDone && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  NSError *mediaError;
  AVKeyValueStatus mediaStatus = [asset statusOfValueForKey:@"playable" error:&mediaError];
  if (mediaError) fprintf(stderr, "Media error %ld\n", (long)mediaError.code);
  check(mediaDone && mediaStatus == AVKeyValueStatusLoaded && asset.playable, @"Production media loader loads playable MP4 with private CA");
  check(fabs(CMTimeGetSeconds(asset.duration) - 2.0) < 0.01, @"Production media loader reports correct duration");
  [asset cancelLoading];
  BittyRunnerMediaLoader *loader = objc_getAssociatedObject(asset, @selector(attachToAsset:headers:));
  NSOperationQueue *loaderQueue = [loader valueForKey:@"queue"];
  TestMediaLoading *first = mediaRequest(origin, @"/test.mp4", 100, 48);
  TestMediaLoading *second = mediaRequest(origin, @"/test.mp4", 400, 72);
  [loaderQueue addOperationWithBlock:^{
    [loader resourceLoader:asset.resourceLoader shouldWaitForLoadingOfRequestedResource:(id)first];
    [loader resourceLoader:asset.resourceLoader shouldWaitForLoadingOfRequestedResource:(id)second];
  }];
  check(waitUntil(^BOOL{ return first.isFinished && second.isFinished; }) && !first.error && !second.error,
        @"Concurrent nonzero-offset media ranges complete");
  NSData *fixture = [NSData dataWithContentsOfFile:[base stringByAppendingPathComponent:@"test.mp4"]];
  check([first.dataRequest.received isEqual:[fixture subdataWithRange:NSMakeRange(100,48)]] &&
        [second.dataRequest.received isEqual:[fixture subdataWithRange:NSMakeRange(400,72)]],
        @"Range seek data matches the exact requested bytes");
  TestMediaLoading *malformed = mediaRequest(origin, @"/malformed.mp4", 300, 48);
  [loaderQueue addOperationWithBlock:^{
    [loader resourceLoader:asset.resourceLoader shouldWaitForLoadingOfRequestedResource:(id)malformed];
  }];
  check(waitUntil(^BOOL{ return malformed.isFinished; }) && malformed.error.code == NSURLErrorBadServerResponse &&
        malformed.dataRequest.received.length == 0, @"Incorrect server Content-Range is rejected before media delivery");
  TestMediaLoading *slow = mediaRequest(origin, @"/slow.mp4", 0, 200000);
  [loaderQueue addOperationWithBlock:^{
    [loader resourceLoader:asset.resourceLoader shouldWaitForLoadingOfRequestedResource:(id)slow];
  }];
  check(waitUntil(^BOOL{ return slow.dataRequest.received.length > 0; }), @"Media delivers incremental bytes before transfer completion");
  slow.isCancelled = YES;
  [loaderQueue addOperationWithBlock:^{
    [loader resourceLoader:asset.resourceLoader didCancelLoadingRequest:(id)slow];
  }];
  check(waitUntil(^BOOL{ return [(NSDictionary *)[loader valueForKey:@"requests"] count] == 0; }) && !slow.isFinished,
        @"Active media cancellation removes and cancels its network request");
  printf("ALL NATIVE HTTP, WEBSOCKET AND MEDIA TESTS PASSED\n");
}}
