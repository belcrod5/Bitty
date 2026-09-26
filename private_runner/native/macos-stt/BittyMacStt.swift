import Foundation
import AVFoundation
import Speech

final class Output: @unchecked Sendable {
    private let lock = NSLock()

    func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        lock.lock()
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
        lock.unlock()
    }
}

final class Completion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        await withCheckedContinuation { next in
            lock.lock()
            if finished { next.resume() } else { continuation = next }
            lock.unlock()
        }
    }

    func finish() {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let next = continuation
        continuation = nil
        lock.unlock()
        next?.resume()
    }
}

@main
struct BittyMacStt {
    static func main() async {
        let output = Output()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP")) else {
            output.send(["type": "error", "code": "macos_locale_unavailable"])
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            output.send(["type": "error", "code": "macos_on_device_unavailable"])
            return
        }
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
        }
        guard authorization == .authorized else {
            output.send(["type": "error", "code": "macos_speech_permission_denied"])
            return
        }
        guard recognizer.isAvailable else {
            output.send(["type": "error", "code": "macos_recognizer_unavailable"])
            return
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else {
            output.send(["type": "error", "code": "macos_audio_format_unavailable"])
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        let completion = Completion()
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                output.send([
                    "type": "transcript",
                    "text": result.bestTranscription.formattedString,
                    "isFinal": result.isFinal,
                ])
                if result.isFinal {
                    completion.finish()
                    return
                }
            }
            if error != nil {
                output.send(["type": "error", "code": "macos_recognition_failed"])
                completion.finish()
            }
        }
        output.send(["type": "ready"])

        var pending = Data()
        while true {
            let chunk = FileHandle.standardInput.readData(ofLength: 15_360)
            if chunk.isEmpty { break }
            pending.append(chunk)
            let evenCount = pending.count - pending.count % 2
            if evenCount == 0 { continue }
            let data = pending.prefix(evenCount)
            pending.removeFirst(evenCount)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
                  let samples = buffer.int16ChannelData else {
                output.send(["type": "error", "code": "macos_invalid_audio"])
                task.cancel()
                return
            }
            buffer.frameLength = AVAudioFrameCount(data.count / 2)
            data.withUnsafeBytes { bytes in
                if let base = bytes.baseAddress { memcpy(samples[0], base, data.count) }
            }
            request.append(buffer)
        }
        if !pending.isEmpty {
            output.send(["type": "error", "code": "macos_invalid_audio"])
            task.cancel()
            return
        }
        request.endAudio()
        await completion.wait()
    }
}
