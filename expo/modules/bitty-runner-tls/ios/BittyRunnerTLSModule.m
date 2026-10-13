#import "BittyRunnerTLS.h"
#import <React/RCTEventEmitter.h>

#import "BittyRunnerSocket.h"

@interface BittyRunnerTLSModule : RCTEventEmitter
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, BittyRunnerSocket *> *sockets;
@property(nonatomic, copy) NSString *pairedOrigin;
@property(nonatomic, copy) NSString *pairedCertificate;
@end

@implementation BittyRunnerTLSModule
RCT_EXPORT_MODULE(BittyRunnerTLS)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"BittyRunnerWebSocket"]; }
- (instancetype)init {
  self = [super init];
  if (self) _sockets = [NSMutableDictionary new];
  return self;
}

RCT_REMAP_METHOD(configure, configureOrigin:(NSString *)origin certificate:(NSString *)certificate
                 resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [BittyRunnerTLS install];
  NSError *error = nil;
  if (![[BittyRunnerTLS shared] configureOrigin:origin certificate:certificate error:&error]) {
    reject(@"runner_tls_configuration_invalid", @"Runner証明書を保存できませんでした。", error);
    return;
  }
  if (![self.pairedOrigin isEqual:origin] || ![self.pairedCertificate isEqual:certificate]) {
    // A new pairing must not leave old authenticated sockets alive.
    for (BittyRunnerSocket *socket in self.sockets.allValues) {
      [socket finishCode:1000 reason:@"pairing_changed" error:NO];
    }
  }
  self.pairedOrigin = origin;
  self.pairedCertificate = certificate;
  resolve(nil);
}

RCT_EXPORT_METHOD(connect:(NSNumber *)identifier url:(NSString *)urlString headers:(NSDictionary *)headers) {
  NSURL *url = [NSURL URLWithString:urlString];
  NSString *authorization = nil;
  for (NSString *name in headers) {
    if ([name caseInsensitiveCompare:@"Authorization"] == NSOrderedSame) authorization = headers[name];
  }
  if (![url.scheme.lowercaseString isEqual:@"wss"] || ![[BittyRunnerTLS shared] handlesURL:url] ||
      ![authorization isKindOfClass:NSString.class] || ![authorization hasPrefix:@"Bearer "] ||
      ![[authorization substringFromIndex:7] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length) {
    [self sendEventWithName:@"BittyRunnerWebSocket" body:@{
      @"id":identifier, @"type":@"error", @"message":@"runner_tls_connection_invalid"
    }];
    [self sendEventWithName:@"BittyRunnerWebSocket" body:@{
      @"id":identifier, @"type":@"close", @"code":@1006, @"reason":@"runner_tls_connection_invalid"
    }];
    return;
  }
  BittyRunnerSocket *old = self.sockets[identifier];
  [old finishCode:1000 reason:@"replaced" error:NO];
  BittyRunnerSocket *socket = [BittyRunnerSocket new];
  self.sockets[identifier] = socket;
  __weak BittyRunnerTLSModule *weakSelf = self;
  __weak BittyRunnerSocket *weakSocket = socket;
  socket.emit = ^(NSDictionary *event) {
    BittyRunnerTLSModule *module = weakSelf;
    if (!module || module.sockets[identifier] != weakSocket) return;
    NSMutableDictionary *body = [event mutableCopy];
    body[@"id"] = identifier;
    [module sendEventWithName:@"BittyRunnerWebSocket" body:body];
    if ([event[@"type"] isEqual:@"close"]) [module.sockets removeObjectForKey:identifier];
  };
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.timeoutInterval = 15;
  for (NSString *name in headers) {
    if ([name.lowercaseString hasPrefix:@"cf-access-"]) continue;
    if ([headers[name] isKindOfClass:NSString.class]) [request setValue:headers[name] forHTTPHeaderField:name];
  }
  socket.session = [[BittyRunnerTLS shared] sessionWithDelegate:socket queue:NSOperationQueue.mainQueue];
  socket.task = [socket.session webSocketTaskWithRequest:request];
  [socket.task resume];
}

RCT_REMAP_METHOD(send, sendIdentifier:(NSNumber *)identifier data:(NSString *)data binary:(BOOL)binary
                 resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  BittyRunnerSocket *socket = self.sockets[identifier];
  if (!socket || socket.terminal) {
    reject(@"runner_socket_closed", @"Runner WebSocket is closed", nil);
    return;
  }
  NSData *bytes = binary ? [[NSData alloc] initWithBase64EncodedString:data options:0] : nil;
  if (binary && !bytes) {
    reject(@"runner_socket_payload_invalid", @"Invalid binary payload", nil);
    return;
  }
  NSURLSessionWebSocketMessage *message = binary
    ? [[NSURLSessionWebSocketMessage alloc] initWithData:bytes]
    : [[NSURLSessionWebSocketMessage alloc] initWithString:data];
  [socket.task sendMessage:message completionHandler:^(NSError *error) {
    if (error) reject(@"runner_socket_send_failed", @"Runner WebSocket send failed", nil);
    else resolve(nil);
  }];
}

RCT_EXPORT_METHOD(close:(NSNumber *)identifier code:(NSInteger)code reason:(NSString *)reason) {
  BittyRunnerSocket *socket = self.sockets[identifier];
  if (!socket) return;
  [socket.task cancelWithCloseCode:(NSURLSessionWebSocketCloseCode)code
                           reason:[reason dataUsingEncoding:NSUTF8StringEncoding]];
  [socket finishCode:code reason:reason ?: @"" error:NO];
}

- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (BittyRunnerSocket *socket in self.sockets.allValues) {
      [socket finishCode:1000 reason:@"invalidated" error:NO];
    }
  });
  [super invalidate];
}
@end
