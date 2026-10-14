#import "BittyRunnerMediaLoader.h"
#import "BittyRunnerTLS.h"
#import <objc/runtime.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

@interface BittyRunnerMediaRequest : NSObject
@property(nonatomic, strong) AVAssetResourceLoadingRequest *loading;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, assign) int64_t remaining;
@end
@implementation BittyRunnerMediaRequest
@end

@interface BittyRunnerMediaLoader ()
@property(nonatomic, strong) NSDictionary<NSString *, NSString *> *headers;
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSMutableDictionary<NSValue *, BittyRunnerMediaRequest *> *requests;
@property(nonatomic, strong) NSOperationQueue *queue;
@property(nonatomic, strong) NSURL *sourceOrigin;
@end

@implementation BittyRunnerMediaLoader
+ (void)attachToAsset:(AVURLAsset *)asset headers:(NSDictionary<NSString *, NSString *> *)headers {
  if (![asset.URL.scheme isEqual:@"bitty-runner-media"]) return;
  BittyRunnerMediaLoader *loader = [self new];
  loader.headers = headers;
  NSURLComponents *origin = [NSURLComponents componentsWithURL:asset.URL resolvingAgainstBaseURL:NO];
  origin.scheme = @"https";
  origin.path = @"";
  origin.query = nil;
  origin.fragment = nil;
  loader.sourceOrigin = origin.URL;
  loader.requests = [NSMutableDictionary new];
  loader.queue = [NSOperationQueue new];
  loader.queue.maxConcurrentOperationCount = 1;
  dispatch_queue_t queue = dispatch_queue_create("bitty.runner.media", DISPATCH_QUEUE_SERIAL);
  loader.queue.underlyingQueue = queue;
  objc_setAssociatedObject(asset, @selector(attachToAsset:headers:), loader, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [asset.resourceLoader setDelegate:loader queue:queue];
}

- (BOOL)resourceLoader:(AVAssetResourceLoader *)loader
    shouldWaitForLoadingOfRequestedResource:(AVAssetResourceLoadingRequest *)loading {
  NSURLComponents *components = [NSURLComponents componentsWithURL:loading.request.URL resolvingAgainstBaseURL:NO];
  if (![components.scheme isEqual:@"bitty-runner-media"]) return NO;
  components.scheme = @"https";
  if (![components.host.lowercaseString isEqual:self.sourceOrigin.host.lowercaseString] ||
      (components.port.integerValue ?: 443) != (self.sourceOrigin.port.integerValue ?: 443) ||
      components.user || components.password) {
    [loading finishLoadingWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorServerCertificateUntrusted userInfo:nil]];
    return YES;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:components.URL];
  BOOL pairedLocal = [[BittyRunnerTLS shared] handlesURL:components.URL];
  for (NSString *header in self.headers) {
    if (pairedLocal && [header.lowercaseString hasPrefix:@"cf-access-"]) continue;
    [request setValue:self.headers[header] forHTTPHeaderField:header];
  }
  AVAssetResourceLoadingDataRequest *data = loading.dataRequest;
  int64_t offset = data.currentOffset ?: data.requestedOffset;
  int64_t length = data ? data.requestedLength - (offset - data.requestedOffset) : 2;
  BOOL allToEnd = data.requestsAllDataToEndOfResource;
  if (offset < 0 || (!allToEnd && length <= 0)) {
    [loading finishLoading];
    return YES;
  }
  [request setValue:allToEnd ? [NSString stringWithFormat:@"bytes=%lld-", offset]
      : [NSString stringWithFormat:@"bytes=%lld-%lld", offset, offset + length - 1]
      forHTTPHeaderField:@"Range"];
  if (!self.session) self.session = [[BittyRunnerTLS shared] sessionWithDelegate:self queue:self.queue];
  BittyRunnerMediaRequest *pending = [BittyRunnerMediaRequest new];
  pending.loading = loading;
  pending.remaining = allToEnd ? INT64_MAX : length;
  pending.task = [self.session dataTaskWithRequest:request];
  self.requests[[NSValue valueWithNonretainedObject:pending.task]] = pending;
  [[BittyRunnerTLS shared] logMediaStage:@"media-request" request:request response:nil error:nil];
  [pending.task resume];
  return YES;
}

- (void)finish:(BittyRunnerMediaRequest *)pending error:(NSError *)error {
  if (!pending || !self.requests[[NSValue valueWithNonretainedObject:pending.task]]) return;
  [self.requests removeObjectForKey:[NSValue valueWithNonretainedObject:pending.task]];
  [[BittyRunnerTLS shared] logMediaStage:error ? @"media-error" : @"media-complete"
      request:pending.task.originalRequest response:pending.task.response error:error];
  if (!pending.loading.isCancelled && !pending.loading.isFinished) {
    if (error) [pending.loading finishLoadingWithError:error];
    else [pending.loading finishLoading];
  }
  [pending.task cancel];
  if (self.requests.count == 0) {
    [self.session finishTasksAndInvalidate];
    self.session = nil;
  }
}

- (void)resourceLoader:(AVAssetResourceLoader *)loader didCancelLoadingRequest:(AVAssetResourceLoadingRequest *)loading {
  for (BittyRunnerMediaRequest *pending in self.requests.allValues) {
    if (pending.loading == loading) [self finish:pending error:nil];
  }
}

- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
  [[BittyRunnerTLS shared] handleChallenge:challenge completion:completion];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
    completionHandler:(void (^)(NSURLRequest *))completion {
  [[BittyRunnerTLS shared] logMediaStage:@"media-redirect-denied" request:task.originalRequest response:response error:nil];
  completion(nil);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
  BittyRunnerMediaRequest *pending = self.requests[[NSValue valueWithNonretainedObject:task]];
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  [[BittyRunnerTLS shared] logMediaStage:@"media-response" request:task.originalRequest response:response error:nil];
  NSString *range = [http isKindOfClass:NSHTTPURLResponse.class] ? [http valueForHTTPHeaderField:@"Content-Range"] : nil;
  NSScanner *scanner = [NSScanner scannerWithString:range ?: @""];
  long long start = -1, end = -1, total = -1;
  BOOL validRange = [scanner scanString:@"bytes" intoString:nil] && [scanner scanLongLong:&start] &&
      [scanner scanString:@"-" intoString:nil] && [scanner scanLongLong:&end] &&
      [scanner scanString:@"/" intoString:nil] && [scanner scanLongLong:&total] && scanner.isAtEnd;
  AVAssetResourceLoadingDataRequest *data = pending.loading.dataRequest;
  int64_t expected = data.currentOffset ?: data.requestedOffset;
  if (!pending || http.statusCode != 206 || !validRange || start != expected || end < start || total <= end) {
    completion(NSURLSessionResponseCancel);
    [self finish:pending error:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
    return;
  }
  AVAssetResourceLoadingContentInformationRequest *info = pending.loading.contentInformationRequest;
  info.contentType = [UTType typeWithMIMEType:response.MIMEType ?: @"application/octet-stream"].identifier;
  info.contentLength = total;
  info.byteRangeAccessSupported = YES;
  pending.remaining = MIN(pending.remaining, total - start);
  completion(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  BittyRunnerMediaRequest *pending = self.requests[[NSValue valueWithNonretainedObject:task]];
  if (!pending) return;
  NSUInteger length = (NSUInteger)MIN((int64_t)data.length, pending.remaining);
  [pending.loading.dataRequest respondWithData:length == data.length ? data : [data subdataWithRange:NSMakeRange(0, length)]];
  pending.remaining -= length;
  if (pending.remaining == 0) [self finish:pending error:nil];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  BittyRunnerMediaRequest *pending = self.requests[[NSValue valueWithNonretainedObject:task]];
  if (pending && !error && pending.remaining > 0 && pending.remaining != INT64_MAX) {
    error = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil];
  }
  [self finish:pending error:error];
}
@end
