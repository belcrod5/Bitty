import AVFoundation
import ExpoModulesCore
import Foundation

public class BittyStreamingSttModule: Module {
  private let queue = DispatchQueue(label: "bitty.stt.transport")
  private var current: StreamingSession?

  public func definition() -> ModuleDefinition {
    Name("BittyStreamingStt")
    Events("BittyStreamingSttMessage", "BittyStreamingSttSample", "BittyStreamingSttError", "BittyStreamingSttClose")

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
  private var stopPromise: Promise?
  private var lastSampleTime = CFAbsoluteTimeGetCurrent()
  private(set) var terminal = false

  init(url: URL, headers: [String: String], queue: DispatchQueue, emit: @escaping (String, [String: Any]) -> Void) {
    self.url = url
    self.headers = headers
    self.queue = queue
    self.emit = emit
  }

  func start() {
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: delegateQueue)
    let task = session.webSocketTask(with: request)
    socketSession = session
    socket = task
    task.resume()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    queue.async { [weak self] in
      guard let self, !self.terminal, self.socket === webSocketTask else { return }
      self.pending.append(.string("{\"type\":\"start\",\"sampleRate\":16000}"))
      self.sendNext()
      self.receiveNext()
    }
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
            self.emit("BittyStreamingSttMessage", ["data": text])
            self.beginCapture()
          } else if type == "done" || type == "error" {
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
    AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
      guard let self else { return }
      self.queue.async {
        guard !self.terminal, self.ready, !self.stopping else { return }
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
          try audioSession.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .mixWithOthers])
          try audioSession.setActive(true)
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
          try engine.start()
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
      self?.convert(copy)
    }
  }

  private func convert(_ input: AVAudioPCMBuffer) {
    guard !terminal, let converter, let outputFormat else { return }
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
    pending.append(.data(data))
    sendNext()
  }

  private func sendNext() {
    guard !terminal, !sending, let socket, !pending.isEmpty else { return }
    sending = true
    let message = pending.removeFirst()
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
        if case .string(let value) = message, value == "{\"type\":\"stop\"}" {
          self.stopPromise?.resolve(nil)
          self.stopPromise = nil
        }
        self.sendNext()
      }
    }
  }

  func stop(promise: Promise) {
    guard ready, !stopping else {
      promise.reject("not_recording", "マイクは録音中ではありません。")
      return
    }
    stopping = true
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
    terminal = true
    cleanup()
  }

  private func fail(_ message: String) {
    guard !terminal else { return }
    terminal = true
    cleanup()
    emit("BittyStreamingSttError", ["message": message])
  }
}
