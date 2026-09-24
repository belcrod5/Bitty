#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>

static NSString *BittyTtsTempPath(NSString *extension)
{
  NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:@"bitty-tts-effects"];
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                             withIntermediateDirectories:YES attributes:nil error:nil];
  return [directory stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%@.%@", NSUUID.UUID.UUIDString, extension]];
}

static float BittyTtsMix(id value)
{
  return fmaxf(0, fminf(100, [value floatValue]));
}

static NSString *BittyTtsInputExtension(NSURLResponse *response)
{
  NSString *mime = response.MIMEType.lowercaseString;
  if ([mime isEqualToString:@"audio/mpeg"] || [mime isEqualToString:@"audio/mp3"]) return @"mp3";
  if ([mime isEqualToString:@"audio/wav"] || [mime isEqualToString:@"audio/x-wav"]) return @"wav";
  if ([mime isEqualToString:@"audio/mp4"] || [mime isEqualToString:@"audio/x-m4a"]) return @"m4a";
  if ([mime isEqualToString:@"audio/aac"]) return @"aac";
  NSString *extension = response.suggestedFilename.pathExtension.lowercaseString;
  return extension.length ? extension : @"caf";
}

@interface BittyTtsEffectsModule : NSObject <RCTBridgeModule>
@property(nonatomic, strong) NSMutableSet<NSString *> *activeRequests;
@property(nonatomic, strong) NSMutableSet<NSString *> *cancelledRequests;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSURLSessionDownloadTask *> *downloads;
@end

@implementation BittyTtsEffectsModule

RCT_EXPORT_MODULE(BittyTtsEffects)

- (instancetype)init
{
  self = [super init];
  if (self) {
    _activeRequests = [NSMutableSet new];
    _cancelledRequests = [NSMutableSet new];
    _downloads = [NSMutableDictionary new];
  }
  return self;
}

- (BOOL)isCancelled:(NSString *)requestId
{
  @synchronized(self) {
    return [_cancelledRequests containsObject:requestId];
  }
}

- (void)finishRequest:(NSString *)requestId
{
  @synchronized(self) {
    [_activeRequests removeObject:requestId];
    [_cancelledRequests removeObject:requestId];
    [_downloads removeObjectForKey:requestId];
  }
}

RCT_REMAP_METHOD(process,
                 processUri:(NSString *)uri
                 effect:(NSDictionary *)effect
                 requestId:(NSString *)requestId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  NSURL *url = [NSURL URLWithString:uri];
  if (!url || ![@[ @"file", @"http", @"https" ] containsObject:url.scheme.lowercaseString]) {
    reject(@"invalid_uri", @"TTS音声URLが不正です。", nil);
    return;
  }
  @synchronized(self) {
    [_activeRequests addObject:requestId];
  }

  void (^render)(NSURL *, BOOL) = ^(NSURL *inputURL, BOOL deleteInput) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *outputPath = BittyTtsTempPath(@"caf");
      NSError *error = nil;
      BOOL success = ![self isCancelled:requestId] &&
          [self renderFile:inputURL toURL:[NSURL fileURLWithPath:outputPath]
                   effect:effect requestId:requestId error:&error];
      if (deleteInput) [[NSFileManager defaultManager] removeItemAtURL:inputURL error:nil];
      BOOL cancelled = [self isCancelled:requestId];
      [self finishRequest:requestId];
      if (success && !cancelled) {
        resolve([NSURL fileURLWithPath:outputPath].absoluteString);
      } else {
        [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
        reject(cancelled ? @"tts_cancelled" : @"tts_effect_failed",
               cancelled ? @"TTS音声加工を中止しました。" : (error.localizedDescription ?: @"TTS音声加工に失敗しました。"),
               error);
      }
    });
  };

  if (url.isFileURL) {
    render(url, NO);
    return;
  }

  NSURLSessionDownloadTask *task = [NSURLSession.sharedSession downloadTaskWithURL:url
      completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
        BOOL cancelled = [self isCancelled:requestId];
        if (cancelled || !location || error ||
            ([response isKindOfClass:NSHTTPURLResponse.class] &&
             ((NSHTTPURLResponse *)response).statusCode >= 400)) {
          [self finishRequest:requestId];
          reject(cancelled ? @"tts_cancelled" : @"tts_download_failed",
                 cancelled ? @"TTS音声加工を中止しました。" : @"TTS音声を取得できませんでした。", error);
          return;
        }
        NSString *inputPath = BittyTtsTempPath(BittyTtsInputExtension(response));
        NSError *moveError = nil;
        if (![[NSFileManager defaultManager] moveItemAtPath:location.path toPath:inputPath error:&moveError]) {
          [self finishRequest:requestId];
          reject(@"tts_download_failed", @"TTS音声を保存できませんでした。", moveError);
          return;
        }
        render([NSURL fileURLWithPath:inputPath], YES);
      }];
  @synchronized(self) {
    _downloads[requestId] = task;
    if ([_cancelledRequests containsObject:requestId]) [task cancel];
  }
  [task resume];
}

RCT_REMAP_METHOD(cancel,
                 cancelRequestId:(NSString *)requestId
                 cancelResolver:(RCTPromiseResolveBlock)resolve
                 cancelRejecter:(RCTPromiseRejectBlock)reject)
{
  @synchronized(self) {
    if ([_activeRequests containsObject:requestId]) {
      [_cancelledRequests addObject:requestId];
      [_downloads[requestId] cancel];
    }
  }
  resolve(nil);
}

- (BOOL)renderFile:(NSURL *)inputURL toURL:(NSURL *)outputURL
           effect:(NSDictionary *)effect requestId:(NSString *)requestId error:(NSError **)error
{
  AVAudioFile *input = [[AVAudioFile alloc] initForReading:inputURL error:error];
  if (!input) return NO;

  AVAudioFormat *format = input.processingFormat;
  AVAudioEngine *engine = [AVAudioEngine new];
  AVAudioPlayerNode *player = [AVAudioPlayerNode new];
  AVAudioUnitDistortion *distortion = [AVAudioUnitDistortion new];
  AVAudioUnitDelay *delay = [AVAudioUnitDelay new];
  AVAudioUnitReverb *reverb = [AVAudioUnitReverb new];
  NSDictionary<NSString *, NSNumber *> *distortionPresets = @{
    @"speechWaves": @(AVAudioUnitDistortionPresetSpeechWaves),
    @"speechAlienChatter": @(AVAudioUnitDistortionPresetSpeechAlienChatter),
    @"speechRadioTower": @(AVAudioUnitDistortionPresetSpeechRadioTower),
  };
  NSDictionary<NSString *, NSNumber *> *reverbPresets = @{
    @"smallRoom": @(AVAudioUnitReverbPresetSmallRoom),
    @"mediumRoom": @(AVAudioUnitReverbPresetMediumRoom),
    @"plate": @(AVAudioUnitReverbPresetPlate),
  };
  [distortion loadFactoryPreset:(AVAudioUnitDistortionPreset)
      [distortionPresets[effect[@"distortion"][@"preset"]] integerValue]];
  distortion.wetDryMix = BittyTtsMix(effect[@"distortion"][@"wetDryMix"]);
  delay.delayTime = fmax(0, fmin(2, [effect[@"delay"][@"time"] doubleValue]));
  delay.feedback = fmaxf(0, fminf(100, [effect[@"delay"][@"feedback"] floatValue]));
  delay.wetDryMix = BittyTtsMix(effect[@"delay"][@"wetDryMix"]);
  [reverb loadFactoryPreset:(AVAudioUnitReverbPreset)
      [reverbPresets[effect[@"reverb"][@"preset"]] integerValue]];
  reverb.wetDryMix = BittyTtsMix(effect[@"reverb"][@"wetDryMix"]);

  [engine attachNode:player];
  [engine attachNode:distortion];
  [engine attachNode:delay];
  [engine attachNode:reverb];
  [engine connect:player to:distortion format:format];
  [engine connect:distortion to:delay format:format];
  [engine connect:delay to:reverb format:format];
  [engine connect:reverb to:engine.mainMixerNode format:format];

  AVAudioFormat *renderFormat = [[AVAudioFormat alloc]
      initStandardFormatWithSampleRate:format.sampleRate channels:format.channelCount];
  if (![engine enableManualRenderingMode:AVAudioEngineManualRenderingModeOffline
                                 format:renderFormat maximumFrameCount:4096 error:error]) return NO;

  NSDictionary *settings = @{
    AVFormatIDKey: @(kAudioFormatLinearPCM),
    AVSampleRateKey: @(format.sampleRate),
    AVNumberOfChannelsKey: @(format.channelCount),
    AVLinearPCMBitDepthKey: @32,
    AVLinearPCMIsFloatKey: @YES,
    AVLinearPCMIsNonInterleaved: @YES,
  };
  AVAudioFile *output = [[AVAudioFile alloc] initForWriting:outputURL settings:settings
      commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:error];
  if (!output) return NO;

  [player scheduleFile:input atTime:nil completionHandler:nil];
  if (![engine startAndReturnError:error]) return NO;
  [player play];
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc]
      initWithPCMFormat:engine.manualRenderingFormat frameCapacity:4096];
  // Render a short tail so delay and room reflections do not end with the speech.
  AVAudioFramePosition totalFrames = input.length + (AVAudioFramePosition)(format.sampleRate * 0.18);
  NSUInteger retries = 0;
  BOOL completed = YES;
  while (engine.manualRenderingSampleTime < totalFrames && ![self isCancelled:requestId]) {
    AVAudioFrameCount frames = (AVAudioFrameCount)MIN(4096, totalFrames - engine.manualRenderingSampleTime);
    AVAudioEngineManualRenderingStatus status = [engine renderOffline:frames toBuffer:buffer error:error];
    if (status == AVAudioEngineManualRenderingStatusSuccess) {
      if (![output writeFromBuffer:buffer error:error]) {
        completed = NO;
        break;
      }
      retries = 0;
    } else if (status == AVAudioEngineManualRenderingStatusCannotDoInCurrentContext && retries++ < 8) {
      continue;
    } else {
      if (error && !*error) {
        *error = [NSError errorWithDomain:@"BittyTtsEffects" code:1
                                 userInfo:@{NSLocalizedDescriptionKey: @"TTS音声加工に失敗しました。"}];
      }
      completed = NO;
      break;
    }
  }
  [player stop];
  [engine stop];
  return completed && ![self isCancelled:requestId] && (!error || !*error);
}

RCT_REMAP_METHOD(remove,
                 removeUri:(NSString *)uri
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  NSURL *url = [NSURL URLWithString:uri];
  NSString *directory = [[NSTemporaryDirectory() stringByAppendingPathComponent:@"bitty-tts-effects"]
      stringByStandardizingPath];
  NSString *path = url.path.stringByStandardizingPath;
  if (!url.isFileURL || ![path.stringByDeletingLastPathComponent isEqualToString:directory] ||
      ![path.pathExtension.lowercaseString isEqualToString:@"caf"]) {
    reject(@"invalid_uri", @"TTS一時音声URLが不正です。", nil);
    return;
  }
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  resolve(nil);
}

@end
