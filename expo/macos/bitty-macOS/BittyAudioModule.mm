#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

static NSString *const BittyAudioPlaybackStatusEvent = @"BittyAudioPlaybackStatus";
static void *BittyAudioPlayerItemStatusContext = &BittyAudioPlayerItemStatusContext;

static double BittyAudioMilliseconds(CMTime time)
{
  if (!CMTIME_IS_NUMERIC(time) || time.timescale == 0) {
    return 0;
  }
  double seconds = CMTimeGetSeconds(time);
  return isfinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

@interface BittyAudioPlayer : NSObject

@property(nonatomic, copy) NSString *soundId;
@property(nonatomic, copy) NSString *uri;
@property(nonatomic, strong) AVPlayer *player;
@property(nonatomic, strong) AVPlayerItem *item;
@property(nonatomic, strong) id periodicObserver;
@property(nonatomic, strong) id endObserver;
@property(nonatomic, assign) NSInteger progressUpdateIntervalMillis;
@property(nonatomic, assign) BOOL shouldPlay;
@property(nonatomic, assign) BOOL isLooping;
@property(nonatomic, assign) BOOL observingStatus;
@property(nonatomic, copy) void (^emitStatus)(NSDictionary *status);
@property(nonatomic, copy) void (^readyHandler)(NSDictionary *status);
@property(nonatomic, copy) void (^failureHandler)(NSString *message);

- (instancetype)initWithSoundId:(NSString *)soundId
                            uri:(NSString *)uri
                  initialStatus:(NSDictionary *)initialStatus;
- (NSDictionary *)statusWithDidJustFinish:(BOOL)didJustFinish;
- (void)finishLoadingIfPossible;
- (void)setProgressUpdateIntervalMillis:(NSInteger)progressUpdateIntervalMillis;
- (void)play;
- (void)pause;
- (void)seekToMilliseconds:(double)positionMillis completion:(void (^)(void))completion;
- (void)unload;

@end

@implementation BittyAudioPlayer

- (instancetype)initWithSoundId:(NSString *)soundId
                            uri:(NSString *)uri
                  initialStatus:(NSDictionary *)initialStatus
{
  self = [super init];
  if (!self) {
    return nil;
  }

  _soundId = [soundId copy];
  _uri = [uri copy];
  _progressUpdateIntervalMillis = 500;
  _shouldPlay = [initialStatus[@"shouldPlay"] boolValue];
  _isLooping = [initialStatus[@"isLooping"] boolValue];

  NSURL *url = [NSURL URLWithString:uri];
  if (!url) {
    return nil;
  }

  _item = [AVPlayerItem playerItemWithURL:url];
  _player = [AVPlayer playerWithPlayerItem:_item];
  NSNumber *volume = initialStatus[@"volume"];
  if (volume) {
    _player.volume = MAX(0, MIN(1, volume.floatValue));
  }
  _player.muted = [initialStatus[@"isMuted"] boolValue];

  [_item addObserver:self
          forKeyPath:@"status"
             options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew
             context:BittyAudioPlayerItemStatusContext];
  _observingStatus = YES;

  __weak BittyAudioPlayer *weakSelf = self;
  _endObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:AVPlayerItemDidPlayToEndTimeNotification
                  object:_item
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *notification) {
                BittyAudioPlayer *player = weakSelf;
                if (!player) {
                  return;
                }
                BOOL shouldLoop = player.isLooping;
                if (!shouldLoop) {
                  player.shouldPlay = NO;
                }
                if (player.emitStatus) {
                  player.emitStatus([player statusWithDidJustFinish:YES]);
                }
                if (shouldLoop) {
                  [player seekToMilliseconds:0 completion:^{
                    [player play];
                  }];
                }
              }];

  [self installPeriodicObserver];
  return self;
}

- (void)dealloc
{
  [self unload];
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context
{
  if (context != BittyAudioPlayerItemStatusContext) {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    return;
  }

  [self finishLoadingIfPossible];
}

- (void)finishLoadingIfPossible
{
  if (_item.status == AVPlayerItemStatusReadyToPlay) {
    if (_shouldPlay) {
      [_player play];
    }
    NSDictionary *status = [self statusWithDidJustFinish:NO];
    if (_readyHandler) {
      void (^readyHandler)(NSDictionary *) = _readyHandler;
      _readyHandler = nil;
      _failureHandler = nil;
      readyHandler(status);
    }
    return;
  }

  if (_item.status == AVPlayerItemStatusFailed) {
    NSString *message = _item.error.localizedDescription ?: @"Mac音声の読み込みに失敗しました。";
    if (_failureHandler) {
      void (^failureHandler)(NSString *) = _failureHandler;
      _readyHandler = nil;
      _failureHandler = nil;
      failureHandler(message);
    }
  }
}

- (NSDictionary *)statusWithDidJustFinish:(BOOL)didJustFinish
{
  if (!_player || !_item || _item.status == AVPlayerItemStatusFailed) {
    NSString *message = _item.error.localizedDescription;
    return message
      ? @{ @"isLoaded" : @NO, @"error" : message }
      : @{ @"isLoaded" : @NO };
  }

  double durationMillis = BittyAudioMilliseconds(_item.duration);
  double positionMillis = BittyAudioMilliseconds(_player.currentTime);
  BOOL isPlaying = _player.rate != 0;
  BOOL isBuffering = _player.timeControlStatus == AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate;

  NSMutableDictionary *status = [@{
    @"isLoaded" : @YES,
    @"uri" : _uri,
    @"progressUpdateIntervalMillis" : @(_progressUpdateIntervalMillis),
    @"positionMillis" : @(positionMillis),
    @"shouldPlay" : @(_shouldPlay),
    @"isPlaying" : @(isPlaying),
    @"isBuffering" : @(isBuffering),
    @"rate" : @(_player.rate),
    @"shouldCorrectPitch" : @NO,
    @"volume" : @(_player.volume),
    @"isMuted" : @(_player.muted),
    @"audioPan" : @0,
    @"isLooping" : @(_isLooping),
    @"didJustFinish" : @(didJustFinish),
  } mutableCopy];
  if (durationMillis > 0) {
    status[@"durationMillis"] = @(durationMillis);
  }
  return status;
}

- (void)setProgressUpdateIntervalMillis:(NSInteger)progressUpdateIntervalMillis
{
  _progressUpdateIntervalMillis = MAX(16, progressUpdateIntervalMillis);
  [self installPeriodicObserver];
}

- (void)installPeriodicObserver
{
  if (_periodicObserver && _player) {
    [_player removeTimeObserver:_periodicObserver];
    _periodicObserver = nil;
  }
  if (!_player) {
    return;
  }

  CMTime interval = CMTimeMakeWithSeconds(_progressUpdateIntervalMillis / 1000.0, NSEC_PER_SEC);
  __weak BittyAudioPlayer *weakSelf = self;
  _periodicObserver = [_player
      addPeriodicTimeObserverForInterval:interval
                                   queue:dispatch_get_main_queue()
                              usingBlock:^(__unused CMTime time) {
                                BittyAudioPlayer *player = weakSelf;
                                if (player.emitStatus) {
                                  player.emitStatus([player statusWithDidJustFinish:NO]);
                                }
                              }];
}

- (void)play
{
  _shouldPlay = YES;
  [_player play];
}

- (void)pause
{
  _shouldPlay = NO;
  [_player pause];
}

- (void)seekToMilliseconds:(double)positionMillis completion:(void (^)(void))completion
{
  CMTime time = CMTimeMakeWithSeconds(MAX(0, positionMillis) / 1000.0, NSEC_PER_SEC);
  [_player seekToTime:time
      toleranceBefore:kCMTimeZero
       toleranceAfter:kCMTimeZero
    completionHandler:^(__unused BOOL finished) {
      if (completion) {
        completion();
      }
    }];
}

- (void)unload
{
  [_player pause];
  if (_periodicObserver && _player) {
    [_player removeTimeObserver:_periodicObserver];
    _periodicObserver = nil;
  }
  if (_endObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:_endObserver];
    _endObserver = nil;
  }
  if (_observingStatus && _item) {
    [_item removeObserver:self forKeyPath:@"status" context:BittyAudioPlayerItemStatusContext];
    _observingStatus = NO;
  }
  [_player replaceCurrentItemWithPlayerItem:nil];
  _player = nil;
  _item = nil;
  _emitStatus = nil;
  _readyHandler = nil;
  _failureHandler = nil;
}

@end

@interface BittyAudioModule : RCTEventEmitter <RCTBridgeModule>
@property(nonatomic, strong) NSMutableDictionary<NSString *, BittyAudioPlayer *> *players;
@property(nonatomic, assign) BOOL hasListeners;
@end

@implementation BittyAudioModule

RCT_EXPORT_MODULE(BittyAudio)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _players = [NSMutableDictionary dictionary];
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ BittyAudioPlaybackStatusEvent ];
}

- (void)startObserving
{
  _hasListeners = YES;
}

- (void)stopObserving
{
  _hasListeners = NO;
}

- (void)emitStatus:(NSDictionary *)status forSoundId:(NSString *)soundId
{
  if (_hasListeners) {
    [self sendEventWithName:BittyAudioPlaybackStatusEvent
                       body:@{ @"soundId" : soundId, @"status" : status }];
  }
}

- (BittyAudioPlayer *)playerForSoundId:(NSString *)soundId
                              rejecter:(RCTPromiseRejectBlock)reject
{
  BittyAudioPlayer *player = _players[soundId];
  if (!player) {
    reject(@"audio_unloaded", @"Mac音声は既に解放されています。", nil);
  }
  return player;
}

RCT_REMAP_METHOD(create,
                 createWithUri:(NSString *)uri
                 initialStatus:(NSDictionary *)initialStatus
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *soundId = NSUUID.UUID.UUIDString;
  BittyAudioPlayer *player = [[BittyAudioPlayer alloc]
      initWithSoundId:soundId
                  uri:uri
        initialStatus:initialStatus ?: @{}];
  if (!player) {
    reject(@"audio_url_invalid", @"Mac音声URLが不正です。", nil);
    return;
  }

  __weak BittyAudioModule *weakSelf = self;
  __weak BittyAudioPlayer *weakPlayer = player;
  player.emitStatus = ^(NSDictionary *status) {
    [weakSelf emitStatus:status forSoundId:soundId];
  };
  player.readyHandler = ^(NSDictionary *status) {
    resolve(@{ @"soundId" : soundId, @"status" : status });
  };
  player.failureHandler = ^(NSString *message) {
    [weakPlayer unload];
    [weakSelf.players removeObjectForKey:soundId];
    reject(@"audio_load_failed", message, nil);
  };
  _players[soundId] = player;
  [player finishLoadingIfPossible];
}

RCT_REMAP_METHOD(getStatus,
                 getStatusForSoundId:(NSString *)soundId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (player) {
    resolve([player statusWithDidJustFinish:NO]);
  }
}

RCT_REMAP_METHOD(setStatus,
                 setStatusForSoundId:(NSString *)soundId
                 status:(NSDictionary *)status
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (!player) {
    return;
  }

  NSNumber *progressInterval = status[@"progressUpdateIntervalMillis"];
  if (progressInterval) {
    player.progressUpdateIntervalMillis = progressInterval.integerValue;
  }
  NSNumber *volume = status[@"volume"];
  if (volume) {
    player.player.volume = MAX(0, MIN(1, volume.floatValue));
  }
  NSNumber *muted = status[@"isMuted"];
  if (muted) {
    player.player.muted = muted.boolValue;
  }
  NSNumber *isLooping = status[@"isLooping"];
  if (isLooping) {
    player.isLooping = isLooping.boolValue;
  }

  void (^finish)(void) = ^{
    NSNumber *shouldPlay = status[@"shouldPlay"];
    if (shouldPlay.boolValue) {
      [player play];
    } else if (shouldPlay) {
      [player pause];
    }
    NSDictionary *nextStatus = [player statusWithDidJustFinish:NO];
    resolve(nextStatus);
  };

  NSNumber *positionMillis = status[@"positionMillis"];
  if (positionMillis) {
    [player seekToMilliseconds:positionMillis.doubleValue completion:finish];
  } else {
    finish();
  }
}

RCT_REMAP_METHOD(play,
                 playSoundId:(NSString *)soundId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (player) {
    [player play];
    NSDictionary *status = [player statusWithDidJustFinish:NO];
    resolve(status);
  }
}

RCT_REMAP_METHOD(playFromPosition,
                 playSoundId:(NSString *)soundId
                 fromPositionMillis:(nonnull NSNumber *)positionMillis
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (!player) {
    return;
  }
  [player seekToMilliseconds:positionMillis.doubleValue completion:^{
    [player play];
    NSDictionary *status = [player statusWithDidJustFinish:NO];
    resolve(status);
  }];
}

RCT_REMAP_METHOD(stop,
                 stopSoundId:(NSString *)soundId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (!player) {
    return;
  }
  [player pause];
  [player seekToMilliseconds:0 completion:^{
    NSDictionary *status = [player statusWithDidJustFinish:NO];
    resolve(status);
  }];
}

RCT_REMAP_METHOD(unload,
                 unloadSoundId:(NSString *)soundId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  BittyAudioPlayer *player = [self playerForSoundId:soundId rejecter:reject];
  if (!player) {
    return;
  }
  [player unload];
  [_players removeObjectForKey:soundId];
  resolve(@{ @"isLoaded" : @NO });
}

@end
