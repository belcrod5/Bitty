#import "BittyRunnerSocket.h"
#import "BittyRunnerTLS.h"

@implementation BittyRunnerSocket
- (void)setTask:(NSURLSessionWebSocketTask *)task {
  _task = task;
  // Runner envelopes permit 32 Mi UTF-16 code units; TLS transport limits bytes.
  task.maximumMessageSize = 32 * 1024 * 1024 * 4;
}
- (void)finishCode:(NSInteger)code reason:(NSString *)reason error:(BOOL)error {
  if (self.terminal) return;
  self.terminal = YES;
  if (error) self.emit(@{@"type":@"error", @"message":@"Runner TLS WebSocket connection failed"});
  self.emit(@{@"type":@"close", @"code":@(code), @"reason":reason ?: @""});
  [self.session invalidateAndCancel];
}
- (void)receive {
  __weak BittyRunnerSocket *weakSelf = self;
  [self.task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      BittyRunnerSocket *socket = weakSelf;
      if (!socket || socket.terminal) return;
      if (error) { [socket finishCode:1006 reason:@"receive_failed" error:YES]; return; }
      BOOL binary = message.type == NSURLSessionWebSocketMessageTypeData;
      socket.emit(@{@"type":@"message", @"binary":@(binary),
        @"data":binary ? [message.data base64EncodedStringWithOptions:0] : message.string});
      [socket receive];
    });
  }];
}
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
  completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
  [[BittyRunnerTLS shared] handleChallenge:challenge completion:completion];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task
  didOpenWithProtocol:(NSString *)protocol {
  if (self.terminal) return;
  self.emit(@{@"type":@"open"});
  [self receive];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task
  didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
  [self finishCode:code reason:[[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] ?: @"" error:NO];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (error) [self finishCode:1006 reason:@"connection_failed" error:YES];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
  willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
  completionHandler:(void (^)(NSURLRequest *))completion { completion(nil); }
@end
