#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface BittyMicrophoneModule : RCTEventEmitter <RCTBridgeModule>
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, assign) NSUInteger generation;
@property(nonatomic, assign) BOOL hasListeners;
@end

@implementation BittyMicrophoneModule

RCT_EXPORT_MODULE(BittyMicrophone)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[ @"BittyMicrophoneData", @"BittyMicrophoneError" ]; }
- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving { _hasListeners = NO; }

- (void)stopCapture
{
  _generation += 1;
  if (_engine) {
    [_engine.inputNode removeTapOnBus:0];
    [_engine stop];
    _engine = nil;
  }
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  [self stopCapture];
  resolve(nil);
}

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  if (_engine) {
    reject(@"already_recording", @"マイクは既に使用中です。", nil);
    return;
  }

  NSUInteger generation = ++_generation;
  void (^begin)(BOOL) = ^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.generation) {
        reject(@"recording_cancelled", @"マイクの開始が中止されました。", nil);
        return;
      }
      if (!granted) {
        reject(@"microphone_denied", @"Macのマイク使用が許可されていません。", nil);
        return;
      }

      AVAudioEngine *engine = [[AVAudioEngine alloc] init];
      AVAudioInputNode *input = engine.inputNode;
      AVAudioFormat *inputFormat = [input inputFormatForBus:0];
      AVAudioFormat *outputFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                                     sampleRate:16000
                                                                       channels:1
                                                                    interleaved:YES];
      AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:inputFormat
                                                                    toFormat:outputFormat];
      if (!converter || inputFormat.sampleRate <= 0) {
        reject(@"microphone_format", @"マイクの音声形式を変換できません。", nil);
        return;
      }

      self.engine = engine;
      __weak BittyMicrophoneModule *weakSelf = self;
      [input installTapOnBus:0 bufferSize:4096 format:inputFormat block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        BittyMicrophoneModule *module = weakSelf;
        if (!module) return;

        AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(buffer.frameLength * 16000.0 / inputFormat.sampleRate) + 64;
        AVAudioPCMBuffer *converted = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outputFormat
                                                                   frameCapacity:capacity];
        __block BOOL supplied = NO;
        NSError *conversionError = nil;
        AVAudioConverterOutputStatus status = [converter convertToBuffer:converted
                                                                   error:&conversionError
                                                      withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount requested, AVAudioConverterInputStatus *inputStatus) {
          if (supplied) {
            *inputStatus = AVAudioConverterInputStatus_NoDataNow;
            return nil;
          }
          supplied = YES;
          *inputStatus = AVAudioConverterInputStatus_HaveData;
          return buffer;
        }];
        if (status == AVAudioConverterOutputStatus_Error) {
          dispatch_async(dispatch_get_main_queue(), ^{
            if (generation == module.generation && module.hasListeners) {
              [module sendEventWithName:@"BittyMicrophoneError" body:@{}];
            }
          });
          return;
        }
        if (converted.frameLength == 0) return;
        NSData *pcm = [NSData dataWithBytes:converted.int16ChannelData[0]
                                    length:converted.frameLength * sizeof(int16_t)];
        NSString *data = [pcm base64EncodedStringWithOptions:0];
        dispatch_async(dispatch_get_main_queue(), ^{
          if (generation == module.generation && module.hasListeners) {
            [module sendEventWithName:@"BittyMicrophoneData" body:@{ @"data": data }];
          }
        });
      }];

      NSError *startError = nil;
      if (![engine startAndReturnError:&startError]) {
        [self stopCapture];
        reject(@"microphone_start", @"マイクを開始できませんでした。", startError);
        return;
      }
      resolve(nil);
    });
  };

  AVAuthorizationStatus authorization = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (authorization == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:begin];
  } else {
    begin(authorization == AVAuthorizationStatusAuthorized);
  }
}

- (void)invalidate
{
  [self stopCapture];
  [super invalidate];
}

@end
