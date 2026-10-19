import AVFoundation
import ExpoModulesCore
import Foundation
import BittyRunnerTLS

public class BittyStreamingSttModule: Module {
  private let queue = DispatchQueue(label: "bitty.stt.transport")
  private var current: StreamingSession?

  public func definition() -> ModuleDefinition {
    Name("BittyStreamingStt")
    Constant("captureDiagnosticsVersion") { 1 }
    Constant("continuationVersion") { 1 }
    Constant("controlVersion") { 1 }
    Events("BittyStreamingSttMessage", "BittyStreamingSttSample", "BittyStreamingSttError", "BittyStreamingSttClose", "BittyStreamingSttDiagnostic")

    AsyncFunction("hasPermission") {
      AVAudioSession.sharedInstance().recordPermission == .granted
    }

    AsyncFunction("start") { (urlString: String, headers: [String: String], promise: Promise) in
      self.queue.async {
        guard self.current?.terminal != false else {
          promise.reject("already_active", "音声認識は既に実行中です。")
          return
        }
        let authorization = headers.first {
          $0.key.caseInsensitiveCompare("Authorization") == .orderedSame
        }?.value ?? ""
        guard let url = URL(string: urlString), ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil, url.path == "/stream-stt",
              authorization.hasPrefix("Bearer "),
              !String(authorization.dropFirst(7)).trimmingCharacters(in: .whitespaces).isEmpty else {
          promise.reject("invalid_connection", "音声認識の接続設定が無効です。")
          return
        }
        let session = StreamingSession(url: url, headers: headers, queue: self.queue) { [weak self] name, body in
          self?.sendEvent(name, body)
        }
        self.current = session
        session.start()
        promise.resolve(nil)
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.queue.async {
        guard let current = self.current, !current.terminal else {
          promise.reject("not_active", "音声認識は実行されていません。")
          return
        }
        current.stop(promise: promise)
      }
    }

    AsyncFunction("commit") { (revision: Int, promise: Promise) in
      self.queue.async {
        guard let current = self.current, !current.terminal else {
          promise.reject("not_active", "音声認識は実行されていません。")
          return
        }
        current.commit(revision: revision, promise: promise)
      }
    }

    AsyncFunction("setInputMuted") { (muted: Bool, promise: Promise) in
      self.queue.async {
        self.current?.setInputMuted(muted)
        promise.resolve(nil)
      }
    }

    AsyncFunction("abort") { (promise: Promise) in
      self.queue.async {
        self.current?.abort()
        self.current = nil
        promise.resolve(nil)
      }
    }

    OnDestroy {
      self.queue.async {
        self.current?.abort()
        self.current = nil
      }
    }
  }
}

private final class StreamingSession: NSObject, URLSessionWebSocketDelegate {
  private static let frameBytes = 3_200 // 100 ms of 16 kHz, mono, signed PCM16.
  private static let maxPendingBytes = 256 * 1024
  private let queue: DispatchQueue
  private let url: URL
  private let headers: [String: String]
  private let emit: (String, [String: Any]) -> Void
  private let diagnosticSessionId = UUID().uuidString
  private let diagnosticStartedAt = ProcessInfo.processInfo.systemUptime
  private var diagnosticStages = Set<String>()
  private var capturedBuffers = 0
  private var capturedFrames = 0
  private var convertedFrames = 0
  private var queuedAudioBytes = 0
  private var startedAudioBytes = 0
  private var sentAudioBytes = 0
  private let tapGroup = DispatchGroup()
  private let tapLock = NSLock()
  private var tapOpen = false
  private var tapPool: [AVAudioPCMBuffer] = []
  private var socketSession: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var engine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var outputFormat: AVAudioFormat?
  private var priorAudioCategory: AVAudioSession.Category?
  private var priorAudioMode: AVAudioSession.Mode?
  private var priorAudioOptions: AVAudioSession.CategoryOptions = []
  private var partialPcm = Data()
  private var pending: [URLSessionWebSocketTask.Message] = []
  private var pendingBytes = 0
  private var sending = false
  private var ready = false
  private var stopping = false
  private var inputMuted = false
  private var stopPromise: Promise?
  private var commitPromise: Promise?
  private var commitRevision: Int?
  private var commitTimeout: DispatchWorkItem?
  private var lastSampleTime = CFAbsoluteTimeGetCurrent()
  private(set) var terminal = false

  init(url: URL, headers: [String: String], queue: DispatchQueue, emit: @escaping (String, [String: Any]) -> Void) {
    self.url = url
    self.headers = headers
    self.queue = queue
    self.emit = emit
  }

  // Called only on the transport queue, never on the real-time audio callback.
  private func diagnose(_ stage: String, _ details: [String: Any] = [:]) {
    guard diagnosticStages.insert(stage).inserted else { return }
    var body: [String: Any] = [
      "sessionId": diagnosticSessionId,
      "stage": stage,
      "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - diagnosticStartedAt) * 1_000),
      "capturedBuffers": capturedBuffers,
      "capturedFrames": capturedFrames,
      "convertedFrames": convertedFrames,
      "queuedAudioBytes": queuedAudioBytes,
      "startedAudioBytes": startedAudioBytes,
      "sentAudioBytes": sentAudioBytes,
      "pendingAudioBytes": pendingBytes,
      "partialAudioBytes": partialPcm.count,
      "ready": ready,
      "stopping": stopping,
      "engineRunning": engine?.isRunning ?? false,
    ]
    body.merge(details) { _, value in value }
    emit("BittyStreamingSttDiagnostic", body)
  }

  func start() {
    diagnose("session_started")
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    let session = BittyRunnerTLS.shared().session(withDelegate: self, queue: delegateQueue)
    let task = session.webSocketTask(with: request)
    socketSession = session
    socket = task
    task.resume()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    queue.async { [weak self] in
      guard let self, !self.terminal, self.socket === webSocketTask else { return }
      self.diagnose("socket_opened")
      self.pending.append(.string("{\"type\":\"start\",\"sampleRate\":16000}"))
      self.sendNext()
      self.receiveNext()
    }
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    BittyRunnerTLS.shared().handle(challenge, completion: completionHandler)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    queue.async { [weak self] in
      guard let self, !self.terminal, self.socket === task else { return }
      if error != nil {
        // Handshake failures never call didOpen. Do not expose URLSession errors: they may
        // contain the request URL or authentication details.
        self.fail("Private Runnerへ接続できませんでした。")
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    // Never forward the Runner token or Cloudflare headers to a redirected origin.
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    queue.async { [weak self] in
      guard let self, !self.terminal, self.socket === webSocketTask else { return }
      // A final text message and close callback can arrive on different URLSession queues.
      self.queue.asyncAfter(deadline: .now() + .milliseconds(200)) { [weak self] in
        guard let self, !self.terminal, self.socket === webSocketTask else { return }
        self.diagnose("socket_closed")
        self.terminal = true
        self.cleanup()
        self.emit("BittyStreamingSttClose", [:])
      }
    }
  }

  private func receiveNext() {
    guard let socket, !terminal else { return }
    socket.receive { [weak self, weak socket] result in
      guard let self else { return }
      self.queue.async {
        guard !self.terminal, self.socket === socket else { return }
        switch result {
        case .failure:
          self.fail("Private Runnerとの音声接続が切れました。")
        case .success(.data):
          self.fail("Private Runnerから不正な音声認識応答を受信しました。")
        case .success(.string(let text)):
          guard let bytes = text.data(using: .utf8),
                let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                let type = json["type"] as? String else {
            self.fail("Private Runnerから不正な音声認識応答を受信しました。")
            return
          }
          if type == "ready" {
            guard !self.ready else {
              self.fail("Private Runnerから不正な音声認識応答を受信しました。")
              return
            }
            self.ready = true
            self.diagnose("ready_received")
            self.beginCapture()
          } else if type == "committed" {
            guard let revision = json["revision"] as? Int, revision == self.commitRevision,
                  let accepted = json["accepted"] as? Bool else {
              self.fail("Private Runnerから不正な音声確定応答を受信しました。")
              return
            }
            self.commitTimeout?.cancel()
            self.commitTimeout = nil
            self.commitRevision = nil
            let promise = self.commitPromise
            self.commitPromise = nil
            if accepted {
              self.terminal = true
              self.cleanup()
            }
            promise?.resolve(accepted)
          } else if type == "done" || type == "error" {
            self.diagnose(type == "done" ? "runner_done" : "runner_error")
            self.terminal = true
            self.emit("BittyStreamingSttMessage", ["data": text])
            if type == "done" {
              self.stopPromise?.resolve(nil)
              self.stopPromise = nil
            }
            self.cleanup()
          } else {
            self.emit("BittyStreamingSttMessage", ["data": text])
          }
          if !self.terminal { self.receiveNext() }
        @unknown default:
          self.fail("Private Runnerから不正な音声認識応答を受信しました。")
        }
      }
    }
  }

  private func beginCapture() {
    diagnose("permission_requested")
    AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
      guard let self else { return }
      self.queue.async {
        guard !self.terminal, self.ready, !self.stopping else { return }
        self.diagnose("permission_result", ["permissionGranted": granted])
        guard granted else {
          self.fail("マイクの使用が許可されていません。")
          return
        }
        do {
          let audioSession = AVAudioSession.sharedInstance()
          self.priorAudioCategory = audioSession.category
          self.priorAudioMode = audioSession.mode
          self.priorAudioOptions = audioSession.categoryOptions
          // Match the former recorder's routing. Restore the previous category on cleanup.
          // A speaker override would also change wired and Bluetooth accessory routing.
          self.diagnose("audio_session_configuring")
          try audioSession.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .mixWithOthers])
          try audioSession.setActive(true)
          self.diagnose("audio_session_active")
          let engine = AVAudioEngine()
          let input = engine.inputNode
          let inputFormat = input.outputFormat(forBus: 0)
          guard inputFormat.sampleRate > 0,
                let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                           channels: 1, interleaved: true),
                let converter = AVAudioConverter(from: inputFormat, to: output) else {
            self.fail("マイクの音声形式を変換できません。")
            return
          }
          self.converter = converter
          self.outputFormat = output
          self.engine = engine
          self.tapPool = (0..<8).compactMap { _ in
            AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 8_192)
          }
          guard self.tapPool.count == 8 else {
            self.fail("マイクの音声バッファを確保できませんでした。")
            return
          }
          self.tapLock.lock()
          self.tapOpen = true
          self.tapLock.unlock()
          input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
            self?.enqueueTap(buffer)
          }
          self.diagnose("engine_starting", ["inputSampleRate": inputFormat.sampleRate, "inputChannels": inputFormat.channelCount])
          try engine.start()
          self.diagnose("engine_started")
          self.emit("BittyStreamingSttMessage", ["data": "{\"type\":\"ready\"}"])
        } catch {
          self.fail("マイクを開始できませんでした。")
        }
      }
    }
  }

  private func enqueueTap(_ buffer: AVAudioPCMBuffer) {
    tapLock.lock()
    let copy = tapOpen && buffer.frameLength <= 8_192 ? tapPool.popLast() : nil
    if copy != nil { tapGroup.enter() }
    tapLock.unlock()
    guard let copy else {
      tapLock.lock()
      let enabled = tapOpen
      tapLock.unlock()
      guard enabled else { return }
      queue.async { [weak self] in self?.fail("音声送信が追いつきませんでした。接続を確認して再試行してください。") }
      return
    }
    // Preallocated buffers keep allocation, conversion, and I/O off the real-time callback.
    copy.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for index in 0..<source.count {
      if let from = source[index].mData, let to = target[index].mData {
        memcpy(to, from, Int(source[index].mDataByteSize))
      }
    }
    queue.async { [weak self] in
      defer {
        self?.tapLock.lock()
        self?.tapPool.append(copy)
        self?.tapLock.unlock()
        self?.tapGroup.leave()
      }
      if let self, !self.terminal {
        self.capturedBuffers += 1
        self.capturedFrames += Int(copy.frameLength)
        if self.capturedBuffers == 1 { self.diagnose("first_tap") }
      }
      self?.convert(copy)
    }
  }

  func setInputMuted(_ muted: Bool) {
    inputMuted = muted
    partialPcm.removeAll()
  }

  private func convert(_ input: AVAudioPCMBuffer) {
    guard !terminal, !inputMuted, let converter, let outputFormat else { return }
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16_000 / input.format.sampleRate)) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
      fail("マイクの音声データを読み取れませんでした。")
      return
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      if supplied {
        inputStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return input
    }
    guard status != .error, let samples = converted.int16ChannelData?[0] else {
      fail("マイクの音声データを読み取れませんでした。")
      return
    }
    let count = Int(converted.frameLength)
    if count == 0 { return }
    convertedFrames += count
    if convertedFrames == count { diagnose("first_pcm") }
    partialPcm.append(Data(bytes: samples, count: count * MemoryLayout<Int16>.size))
    let now = CFAbsoluteTimeGetCurrent()
    if now - lastSampleTime >= 0.1 {
      var sum = 0.0
      for index in 0..<count {
        let normalized = Double(samples[index]) / 32_768
        sum += normalized * normalized
      }
      lastSampleTime = now
      emit("BittyStreamingSttSample", ["rms": min(1, sqrt(sum / Double(count)))])
    }
    while partialPcm.count >= Self.frameBytes {
      let frame = Data(partialPcm.prefix(Self.frameBytes))
      partialPcm.removeFirst(Self.frameBytes)
      enqueueAudio(frame)
      if terminal { return }
    }
  }

  private func enqueueAudio(_ data: Data) {
    guard pendingBytes + data.count <= Self.maxPendingBytes else {
      fail("音声送信が追いつきませんでした。接続を確認して再試行してください。")
      return
    }
    pendingBytes += data.count
    queuedAudioBytes += data.count
    if queuedAudioBytes == data.count { diagnose("first_audio_queued") }
    pending.append(.data(data))
    sendNext()
  }

  private func sendNext() {
    guard !terminal, !sending, let socket, !pending.isEmpty else { return }
    sending = true
    let message = pending.removeFirst()
    if case .data(let data) = message {
      startedAudioBytes += data.count
      if startedAudioBytes == data.count { diagnose("first_audio_send_started") }
    }
    socket.send(message) { [weak self] error in
      guard let self else { return }
      self.queue.async {
        guard !self.terminal else { return }
        self.sending = false
        if case .data(let data) = message { self.pendingBytes -= data.count }
        if error != nil {
          self.fail("音声の送信に失敗しました。")
          return
        }
        if case .data(let data) = message {
          self.sentAudioBytes += data.count
          if self.sentAudioBytes == data.count { self.diagnose("first_audio_sent") }
        }
        if case .string(let value) = message, value == "{\"type\":\"stop\"}" {
          self.stopPromise?.resolve(nil)
          self.stopPromise = nil
        }
        self.sendNext()
      }
    }
  }

  func commit(revision: Int, promise: Promise) {
    guard ready, !stopping, revision > 0, commitPromise == nil else {
      promise.reject("invalid_commit", "音声入力を確定できません。")
      return
    }
    commitPromise = promise
    commitRevision = revision
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.commitRevision == revision else { return }
      self.fail("音声入力の確定応答がありません。")
    }
    commitTimeout = timeout
    queue.asyncAfter(deadline: .now() + .seconds(15), execute: timeout)
    // Keep capture running on a rejected commit. Drain captured taps and partial PCM
    // ahead of the control message on the same ordered WebSocket send queue.
    tapGroup.notify(queue: queue) { [weak self] in
      guard let self, !self.terminal, self.commitRevision == revision else { return }
      if !self.partialPcm.isEmpty {
        self.enqueueAudio(self.partialPcm)
        self.partialPcm.removeAll()
      }
      guard !self.terminal else { return }
      self.pending.append(.string("{\"type\":\"commit\",\"revision\":\(revision)}"))
      self.sendNext()
    }
  }

  func stop(promise: Promise) {
    guard ready, !stopping else {
      promise.reject("not_recording", "マイクは録音中ではありません。")
      return
    }
    stopping = true
    diagnose("stop_requested")
    stopPromise = promise
    stopCapture()
    tapGroup.notify(queue: queue) { [weak self] in
      guard let self, !self.terminal else { return }
      if !self.partialPcm.isEmpty {
        self.enqueueAudio(self.partialPcm)
        self.partialPcm.removeAll()
      }
      guard !self.terminal else { return }
      self.pending.append(.string("{\"type\":\"stop\"}"))
      self.sendNext()
    }
  }

  private func stopCapture() {
    tapLock.lock()
    tapOpen = false
    tapLock.unlock()
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      self.engine = nil
    }
    if let category = priorAudioCategory, let mode = priorAudioMode {
      let audioSession = AVAudioSession.sharedInstance()
      let captureOptions: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .mixWithOthers]
      if audioSession.category == .playAndRecord && audioSession.mode == .default &&
          audioSession.categoryOptions == captureOptions {
        // Another owner (for example TTS) may have reconfigured the shared session.
        // Restore only our own category, and never deactivate playback owned elsewhere.
        try? audioSession.setCategory(category, mode: mode, options: priorAudioOptions)
      }
      priorAudioCategory = nil
      priorAudioMode = nil
    }
  }

  private func cleanup() {
    commitTimeout?.cancel()
    commitTimeout = nil
    commitRevision = nil
    commitPromise?.reject("stt_ended", "音声認識の接続が終了しました。")
    commitPromise = nil
    stopCapture()
    converter = nil
    outputFormat = nil
    stopPromise?.reject("stt_ended", "音声認識の接続が終了しました。")
    stopPromise = nil
    pending.removeAll()
    pendingBytes = 0
    partialPcm.removeAll()
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    socketSession?.invalidateAndCancel()
    socketSession = nil
  }

  func abort() {
    guard !terminal else { return }
    diagnose("aborted")
    terminal = true
    cleanup()
  }

  private func fail(_ message: String) {
    guard !terminal else { return }
    diagnose("failed")
    terminal = true
    cleanup()
    emit("BittyStreamingSttError", ["message": message])
  }
}
