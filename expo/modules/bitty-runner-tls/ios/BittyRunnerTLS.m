#import "BittyRunnerTLS.h"
#if __has_include(<React/RCTBridgeModule.h>)
// The official HTTP configuration hook is exported by React's prebuilt binary,
// but RCTHTTPRequestHandler.h is omitted from its public header set.
extern void RCTSetCustomNSURLSessionConfigurationProvider(NSURLSessionConfiguration *(^provider)(void));
#endif

@interface BittyRunnerProtocol : NSURLProtocol <NSURLSessionDataDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@end

@interface BittyRunnerTLS ()
@property(nonatomic, strong) NSURL *origin;
@property(nonatomic, strong) NSData *certificateData;
@end

@implementation BittyRunnerTLS

+ (instancetype)shared {
  static BittyRunnerTLS *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ instance = [BittyRunnerTLS new]; });
  return instance;
}

+ (NSURL *)configurationFile {
  return [[[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory
      inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"bitty-runner-tls.json"];
}

+ (void)install {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSData *data = [NSData dataWithContentsOfURL:[self configurationFile]];
    NSDictionary *configuration = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([configuration isKindOfClass:NSDictionary.class]) {
      [[self shared] configureOrigin:configuration[@"origin"] ?: @""
                         certificate:configuration[@"certificate"] ?: @"" error:nil];
    }
    [NSURLProtocol registerClass:BittyRunnerProtocol.class];
#if __has_include(<React/RCTBridgeModule.h>)
    // React Native fetch and image loading share this public configuration hook.
    RCTSetCustomNSURLSessionConfigurationProvider(^{
      NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.defaultSessionConfiguration;
      NSMutableArray *protocols = [NSMutableArray arrayWithArray:configuration.protocolClasses ?: @[]];
      [protocols removeObject:BittyRunnerProtocol.class];
      [protocols insertObject:BittyRunnerProtocol.class atIndex:0];
      configuration.protocolClasses = protocols;
      return configuration;
    });
#endif
  });
}

- (BOOL)configureOrigin:(NSString *)origin certificate:(NSString *)certificate error:(NSError **)error {
  if (![origin isKindOfClass:NSString.class] || ![certificate isKindOfClass:NSString.class]) return NO;
  NSURL *url = origin.length ? [NSURL URLWithString:origin] : nil;
  NSData *data = certificate.length ? [[NSData alloc] initWithBase64EncodedString:certificate options:0] : nil;
  BOOL valid = !origin.length && !certificate.length;
  if (url && [url.scheme.lowercaseString isEqual:@"https"] && url.host.length && !url.user &&
      !url.password && !url.query && !url.fragment && (!url.path.length || [url.path isEqual:@"/"]) &&
      data.length > 0 && data.length <= 4096) {
    SecCertificateRef parsed = SecCertificateCreateWithData(NULL, (__bridge CFDataRef)data);
    valid = parsed != NULL;
    if (parsed) CFRelease(parsed);
  }
  if (!valid) {
    if (error) *error = [NSError errorWithDomain:@"BittyRunnerTLS" code:1
        userInfo:@{NSLocalizedDescriptionKey:@"Invalid paired Runner TLS configuration"}];
    return NO;
  }
  NSData *configuration = [NSJSONSerialization dataWithJSONObject:@{
    @"origin":origin, @"certificate":certificate
  } options:0 error:error];
  if (!configuration || ![configuration writeToURL:[BittyRunnerTLS configurationFile]
      options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:error]) return NO;
  @synchronized(self) { self.origin = url; self.certificateData = data; }
  return YES;
}

- (BOOL)handlesURL:(NSURL *)url {
  @synchronized(self) {
    NSString *scheme = url.scheme.lowercaseString;
    return self.origin && ([scheme isEqual:@"https"] || [scheme isEqual:@"wss"]) &&
      [url.host.lowercaseString isEqual:self.origin.host.lowercaseString] &&
      (url.port.integerValue ?: 443) == (self.origin.port.integerValue ?: 443) && !url.user && !url.password;
  }
}

- (BOOL)evaluateTrust:(SecTrustRef)trust host:(NSString *)host port:(NSInteger)port {
  NSData *certificateData;
  @synchronized(self) {
    if (![host.lowercaseString isEqual:self.origin.host.lowercaseString] ||
        (port ?: 443) != (self.origin.port.integerValue ?: 443)) return NO;
    certificateData = self.certificateData;
  }
  if (!trust || !certificateData) return NO;
  SecCertificateRef anchor = SecCertificateCreateWithData(NULL, (__bridge CFDataRef)certificateData);
  if (!anchor) return NO;
  SecPolicyRef policy = SecPolicyCreateSSL(true, (__bridge CFStringRef)host);
  OSStatus status = SecTrustSetPolicies(trust, policy);
  CFRelease(policy);
  if (status == errSecSuccess) status = SecTrustSetAnchorCertificates(trust, (__bridge CFArrayRef)@[(__bridge id)anchor]);
  if (status == errSecSuccess) status = SecTrustSetAnchorCertificatesOnly(trust, true);
  // A paired CA is local; fetching unrelated issuers must not change trust.
  if (status == errSecSuccess) status = SecTrustSetNetworkFetchAllowed(trust, false);
  BOOL accepted = status == errSecSuccess && SecTrustEvaluateWithError(trust, NULL);
  CFRelease(anchor);
  return accepted;
}

- (void)handleChallenge:(NSURLAuthenticationChallenge *)challenge
             completion:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
  if (![challenge.protectionSpace.authenticationMethod isEqual:NSURLAuthenticationMethodServerTrust]) {
    completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  NSURLComponents *components = [NSURLComponents new];
  components.scheme = @"https";
  components.host = challenge.protectionSpace.host;
  components.port = @(challenge.protectionSpace.port ?: 443);
  if (![self handlesURL:components.URL]) {
    completion(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    return;
  }
  SecTrustRef trust = challenge.protectionSpace.serverTrust;
  if ([self evaluateTrust:trust host:challenge.protectionSpace.host port:challenge.protectionSpace.port]) {
    completion(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]);
  } else {
    completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
  }
}

- (NSURLSession *)sessionWithDelegate:(id<NSURLSessionDelegate>)delegate queue:(NSOperationQueue *)queue {
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSMutableArray *protocols = [NSMutableArray arrayWithArray:configuration.protocolClasses ?: @[]];
  [protocols removeObject:BittyRunnerProtocol.class];
  configuration.protocolClasses = protocols;
  configuration.URLCredentialStorage = nil;
  return [NSURLSession sessionWithConfiguration:configuration delegate:delegate ?: self delegateQueue:queue];
}

- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
  completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
  [self handleChallenge:challenge completion:completion];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
  willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
  completionHandler:(void (^)(NSURLRequest *))completion {
  // Local endpoints never redirect credentials, including to a different paired port.
  completion(nil);
}

- (NSURL *)mediaURL:(NSURL *)url headers:(NSDictionary<NSString *, NSString *> *)headers {
  if (![url.scheme.lowercaseString isEqual:@"https"] || url.user || url.password) return url;
  BOOL accessId = NO, accessSecret = NO;
  for (NSString *name in headers) {
    id value = headers[name];
    if (![value isKindOfClass:NSString.class] || ![value length]) continue;
    if ([name caseInsensitiveCompare:@"CF-Access-Client-Id"] == NSOrderedSame) accessId = YES;
    if ([name caseInsensitiveCompare:@"CF-Access-Client-Secret"] == NSOrderedSame) accessSecret = YES;
  }
  if (![self handlesURL:url] && !(accessId && accessSecret)) return url;
  NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  components.scheme = @"bitty-runner-media";
  return components.URL;
}
@end

@implementation BittyRunnerProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.URL.scheme.lowercaseString isEqual:@"https"] &&
    ![NSURLProtocol propertyForKey:@"BittyRunnerTLSHandled" inRequest:request] &&
    [[BittyRunnerTLS shared] handlesURL:request.URL];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  NSMutableURLRequest *request = [self.request mutableCopy];
  [NSURLProtocol setProperty:@YES forKey:@"BittyRunnerTLSHandled" inRequest:request];
  [request setValue:nil forHTTPHeaderField:@"CF-Access-Client-Id"];
  [request setValue:nil forHTTPHeaderField:@"CF-Access-Client-Secret"];
  self.session = [[BittyRunnerTLS shared] sessionWithDelegate:self queue:nil];
  self.task = [self.session dataTaskWithRequest:request];
  [self.task resume];
}
- (void)stopLoading { [self.task cancel]; [self.session invalidateAndCancel]; }
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
  completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
  [[BittyRunnerTLS shared] handleChallenge:challenge completion:completion];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
  willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
  completionHandler:(void (^)(NSURLRequest *))completion { completion(nil); }
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
  didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
  [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  completion(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  [self.client URLProtocol:self didLoadData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (error) [self.client URLProtocol:self didFailWithError:error];
  else [self.client URLProtocolDidFinishLoading:self];
  [session finishTasksAndInvalidate];
}
@end
