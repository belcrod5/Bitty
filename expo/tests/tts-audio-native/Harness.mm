#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#include <vector>
#import "../../modules/bitty-tts-effects/ios/BittyTtsEffectsModule.mm"

// File fixtures use production preparation; no network or app bridge is needed.
@implementation BittyRunnerTLS
+ (instancetype)shared { static BittyRunnerTLS *value = [BittyRunnerTLS new]; return value; }
- (void)logMediaStage:(NSString *)stage request:(NSURLRequest *)request
            response:(NSURLResponse *)response error:(NSError *)error {}
@end

// Cancel after the output is created, exercising partial-file cleanup without a timing race.
@interface CancelDuringCopy : BittyTtsEffectsModule
@property(nonatomic, strong) NSURL *outputURL;
@property(nonatomic) BOOL didCancel;
@end
@implementation CancelDuringCopy
- (BOOL)trimFile:(NSURL *)inputURL toURL:(NSURL *)outputURL
       requestId:(NSString *)requestId error:(NSError **)error {
  self.outputURL = outputURL;
  return [super trimFile:inputURL toURL:outputURL requestId:requestId error:error];
}
- (BOOL)isCancelled:(NSString *)requestId {
  if (!self.didCancel && self.outputURL &&
      [[NSFileManager defaultManager] fileExistsAtPath:self.outputURL.path]) {
    self.didCancel = YES;
    [self cancelRequestId:requestId cancelResolver:^(id value) {}
        cancelRejecter:^(NSString *code, NSString *message, NSError *error) {}];
  }
  return [super isCancelled:requestId];
}
@end

static void Check(BOOL condition, NSString *message) {
  if (!condition) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); exit(1); }
}

static NSURL *Write(NSString *directory, const std::vector<std::vector<float>>& samples) {
  NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:
      [NSUUID.UUID.UUIDString stringByAppendingString:@".caf"]]];
  @autoreleasepool {
  AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:24000 channels:(AVAudioChannelCount)samples.size()];
  NSError *error = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForWriting:url settings:format.settings
      commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
  Check(file != nil, @"create fixture");
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:MAX(1, samples[0].size())];
  buffer.frameLength = (AVAudioFrameCount)samples[0].size();
  for (size_t channel = 0; channel < samples.size(); channel++) {
    std::copy(samples[channel].begin(), samples[channel].end(), buffer.floatChannelData[channel]);
  }
  if (buffer.frameLength) Check([file writeFromBuffer:buffer error:&error], @"write fixture");
  }
  return url;
}

static AVAudioFile *Open(NSURL *url) {
  NSError *error = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForReading:url commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
  Check(file != nil, @"open audio");
  return file;
}

static NSURL *Process(BittyTtsEffectsModule *module, NSURL *input, NSDictionary *effect, BOOL expectSuccess = YES) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSURL *result = nil;
  __block NSString *failure = nil;
  [module processUri:input.absoluteString effect:effect requestId:NSUUID.UUID.UUIDString headers:@{}
      resolver:^(id value) { result = [NSURL URLWithString:value]; dispatch_semaphore_signal(done); }
      rejecter:^(NSString *code, NSString *message, NSError *error) { failure = code; dispatch_semaphore_signal(done); }];
  Check(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) == 0, @"preparation completes");
  Check(expectSuccess ? result != nil : failure != nil, @"preparation success/error contract");
  return result;
}

static void VerifyCopy(NSURL *output, const std::vector<std::vector<float>>& input, size_t start, size_t end) {
  AVAudioFile *file = Open(output);
  Check(file.length == end - start, @"only expected edge frames removed");
  Check(file.processingFormat.channelCount == input.size(), @"channel count preserved");
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat frameCapacity:4096];
  NSError *error = nil;
  while (file.framePosition < file.length) {
    size_t offset = (size_t)file.framePosition;
    Check([file readIntoBuffer:buffer error:&error] && buffer.frameLength > 0, @"read prepared PCM");
    for (size_t channel = 0; channel < input.size(); channel++) {
      for (size_t frame = 0; frame < buffer.frameLength; frame++) {
        Check(fabsf(buffer.floatChannelData[channel][frame] - input[channel][start + offset + frame]) < 0.0000001f,
              @"speech, quiet consonants and internal pauses copied unchanged");
      }
    }
  }
  [[NSFileManager defaultManager] removeItemAtURL:output error:nil];
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *directory = [NSString stringWithUTF8String:argv[1]];
    BittyTtsEffectsModule *module = [BittyTtsEffectsModule new];
    std::vector<std::vector<float>> mono(1, std::vector<float>(24000, 0));
    for (size_t frame = 4800; frame < 19200; frame++) mono[0][frame] = frame >= 9600 && frame < 14400 ? 0 : 0.3f;
    NSURL *input = Write(directory, mono);
    VerifyCopy(Process(module, input, nil), mono, 4080, 19920);
    // A quiet, extended consonant must survive, even below -60 dBFS.
    for (size_t frame = 3600; frame < 4800; frame++) mono[0][frame] = 0.0005f;
    for (size_t frame = 19200; frame < 20400; frame++) mono[0][frame] = 0.0005f;
    VerifyCopy(Process(module, Write(directory, mono), nil), mono, 2880, 21120);
    // Relative detection also protects speech in a very quiet recording.
    for (float& value : mono[0]) value *= 0.001f;
    VerifyCopy(Process(module, Write(directory, mono), nil), mono, 2880, 21120);
    std::vector<std::vector<float>> stereo(2, std::vector<float>(24000, 0));
    for (size_t frame = 2400; frame < 16800; frame++) stereo[1][frame] = 0.2f;
    for (size_t frame = 7200; frame < 21600; frame++) stereo[0][frame] = 0.4f;
    VerifyCopy(Process(module, Write(directory, stereo), nil), stereo, 1680, 22320);
    std::vector<std::vector<float>> silent(1, std::vector<float>(4800, 0));
    VerifyCopy(Process(module, Write(directory, silent), nil), silent, 0, 4800);
    std::vector<std::vector<float>> empty(1);
    Process(module, Write(directory, empty), nil, NO);
    // No edge silence: unity effects must not append the former fixed 180 ms.
    std::vector<std::vector<float>> continuous(1, std::vector<float>(24000, 0.2f));
    NSDictionary *unity = @{@"distortion": @{@"preset": @"speechWaves", @"wetDryMix": @0},
        @"delay": @{@"time": @0.06, @"feedback": @14, @"wetDryMix": @0},
        @"reverb": @{@"preset": @"smallRoom", @"wetDryMix": @0}};
    NSURL *rendered = Process(module, Write(directory, continuous), unity);
    Check(Open(rendered).length <= 24000, @"effect renderer adds no artificial tail");
    [[NSFileManager defaultManager] removeItemAtURL:rendered error:nil];
    CancelDuringCopy *cancelled = [CancelDuringCopy new];
    Process(cancelled, input, unity, NO);
    Check(cancelled.didCancel && ![[NSFileManager defaultManager] fileExistsAtPath:cancelled.outputURL.path],
          @"cancellation removes partial audio");
    Check(cancelled.activeRequests.count == 0 && cancelled.cancelledRequests.count == 0,
          @"cancellation clears request state");
    NSLog(@"PASS: mono/stereo edge trim, internal pauses, quiet speech, silence, empty input, cancellation, and no 180 ms tail");
    if (argc > 2) {
      NSString *cache = [NSString stringWithUTF8String:argv[2]];
      NSArray<NSString *> *names = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:cache error:nil];
      NSUInteger count = 0;
      double removedMs = 0;
      double effectRemovedMs = 0;
      NSDictionary *effect = @{@"distortion": @{@"preset": @"speechWaves", @"wetDryMix": @0},
          @"delay": @{@"time": @0.06, @"feedback": @14, @"wetDryMix": @8},
          @"reverb": @{@"preset": @"smallRoom", @"wetDryMix": @3}};
      for (NSString *name in names) {
        if (![name.pathExtension isEqualToString:@"mp3"]) continue;
        NSURL *source = [NSURL fileURLWithPath:[cache stringByAppendingPathComponent:name]];
        AVAudioFile *original = Open(source);
        NSURL *trimmed = Process(module, source, nil);
        AVAudioFile *result = Open(trimmed);
        Check(result.length > 0 && result.length <= original.length, @"cached audio remains nonempty and no longer than source");
        removedMs += 1000.0 * (original.length - result.length) / original.processingFormat.sampleRate;
        [[NSFileManager defaultManager] removeItemAtURL:trimmed error:nil];
        NSURL *themed = Process(module, source, effect);
        AVAudioFile *themedResult = Open(themed);
        Check(themedResult.length > 0 && themedResult.length <= original.length,
              @"themed cached audio remains valid without an appended tail");
        effectRemovedMs += 180 + 1000.0 * (original.length - themedResult.length) / original.processingFormat.sampleRate;
        [[NSFileManager defaultManager] removeItemAtURL:themed error:nil];
        count++;
      }
      printf("PASS: cached fixtures=%lu mean plain edge reduction=%.1f ms; mean themed reduction including former tail=%.1f ms (no audio content logged)\n",
          (unsigned long)count, count ? removedMs / count : 0, count ? effectRemovedMs / count : 0);
    }
  }
  return 0;
}
