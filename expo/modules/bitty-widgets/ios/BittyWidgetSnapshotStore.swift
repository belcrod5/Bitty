import Foundation
import BittyRunnerTLS
import UIKit
import WidgetKit
import OSLog

// Codable is also the allowlist: response fields outside this presentation contract are never persisted.
struct IncomingWidgetSnapshot: Codable {
  struct Orchestrator: Codable {
    let id: String
    let name: String
    var icon: String
  }
  let version: Int
  let connected: Bool
  var orchestrators: [Orchestrator]
  let selectedId: String
  let runningCount: Int?
  let overview: String
  let overviewFetchedAt: Double
  let fiveHourRemaining: Int?
  let weeklyRemaining: Int?
  let usageLimitReached: Bool
  let usageFetchedAt: Double
  var updatedAt: Double?

  var valid: Bool {
    version == 1 && !orchestrators.isEmpty && orchestrators.count <= 100
      && orchestrators.contains(where: { $0.id == selectedId })
      && Set(orchestrators.map(\.id)).count == orchestrators.count
      && orchestrators.allSatisfy { !$0.name.isEmpty && $0.name.count <= 200 && $0.id.count <= 200
        && $0.id.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil && $0.icon.utf8.count <= 1_500_000 }
      && (runningCount ?? 0) >= 0 && overview.count <= 1200
      && overviewFetchedAt.isFinite && overviewFetchedAt >= 0 && usageFetchedAt.isFinite && usageFetchedAt >= 0
      && [fiveHourRemaining, weeklyRemaining].allSatisfy { $0 == nil || (0...100).contains($0!) }
  }
}

final class BittyWidgetSnapshotStore: NSObject, URLSessionTaskDelegate {
  static let shared = BittyWidgetSnapshotStore()
  private let queue = DispatchQueue(label: "bitty.widgetSnapshot")
  private var revision = 0
  private var activeRequest: URLSessionDataTask?
  private let sourceKey = "bitty.widgetSnapshotSource"
  private let logger = Logger(subsystem: "app.bitty.widgets", category: "refresh")
  private lazy var session = BittyRunnerTLS.shared().session(withDelegate: self, queue: nil)

  func activate(runnerUrl: String, runnerToken: String) {
    queue.async {
      let identity = BittyRunnerConnection.identity(runnerUrl: runnerUrl, runnerToken: runnerToken)
      guard UserDefaults.standard.string(forKey: self.sourceKey) != identity else { return }
      self.logger.notice("[widget-refresh] event=source outcome=changed")
      self.revision += 1
      self.activeRequest?.cancel()
      self.invalidateSnapshot()
      // Only an irreversible digest is persisted; credentials remain in the existing app Keychain.
      UserDefaults.standard.set(identity, forKey: self.sourceKey)
    }
  }

  func refresh(expectedRunnerUrl: String? = nil, expectedRunnerToken: String? = nil,
    diagnosticID: String = UUID().uuidString,
    completion: @escaping (UIBackgroundFetchResult) -> Void) {
    queue.async {
      let startedAt = ProcessInfo.processInfo.systemUptime
      self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) app_initiated=\(expectedRunnerUrl != nil)")
      guard let connection = BittyRunnerConnection.load() else {
        self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=connection_unavailable")
        completion(.noData); return
      }
      // Invalidate the old Runner's display as soon as the foreground announces a source change.
      if let expectedRunnerUrl, let expectedRunnerToken,
        !connection.matches(runnerUrl: expectedRunnerUrl, runnerToken: expectedRunnerToken) {
        self.revision += 1
        self.activeRequest?.cancel()
        self.invalidateSnapshot()
        self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=source_mismatch")
        completion(.noData)
        return
      }
      guard UserDefaults.standard.string(forKey: self.sourceKey) == connection.identity else {
        self.revision += 1
        self.activeRequest?.cancel()
        self.invalidateSnapshot()
        self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=source_inactive")
        completion(.noData); return
      }
      self.revision += 1
      let startedRevision = self.revision
      self.activeRequest?.cancel()
      guard var request = connection.request(path: "/app/status-snapshot") else {
        self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=request_unavailable")
        completion(.noData); return
      }
      request.setValue(diagnosticID, forHTTPHeaderField: "X-Bitty-Widget-Refresh-ID")
      let task = self.session.dataTask(with: request) { data, response, error in
        self.queue.async {
          let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
          let status = (response as? HTTPURLResponse)?.statusCode ?? 0
          self.logger.notice("[widget-refresh] event=http id=\(diagnosticID, privacy: .public) status=\(status) duration_ms=\(elapsedMs)")
          guard startedRevision == self.revision else {
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=superseded")
            completion(.noData); return
          }
          guard BittyRunnerConnection.load() == connection,
            UserDefaults.standard.string(forKey: self.sourceKey) == connection.identity else {
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=source_changed")
            completion(.noData); return
          }
          self.activeRequest = nil
          guard error == nil else {
            let code = (error as? URLError)?.code.rawValue ?? 0
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=transport_failed code=\(code)")
            completion(.failed); return
          }
          guard status == 200 else {
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=http_failed")
            completion(.failed); return
          }
          guard let data, data.count <= 16_000_000 else {
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=body_invalid")
            completion(.failed); return
          }
          guard var snapshot = try? JSONDecoder().decode(IncomingWidgetSnapshot.self, from: data), snapshot.valid else {
            self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=schema_invalid")
            completion(.failed); return
          }
          self.logger.notice("[widget-refresh] event=decoded id=\(diagnosticID, privacy: .public) count=\(snapshot.runningCount ?? -1)")
          // Keep bounded images at actual pixel size. The extension never fetches image URLs.
          snapshot.orchestrators = snapshot.orchestrators.map { record in
            var result = record
            result.icon = ""
            if record.icon.hasPrefix("data:image/"), let comma = record.icon.firstIndex(of: ","),
              let bytes = Data(base64Encoded: String(record.icon[record.icon.index(after: comma)...])),
              bytes.count <= 1_100_000, let image = UIImage(data: bytes) {
              let format = UIGraphicsImageRendererFormat()
              format.scale = 1
              let renderer = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 96), format: format)
              result.icon = renderer.pngData { _ in image.draw(in: CGRect(x: 0, y: 0, width: 96, height: 96)) }.base64EncodedString()
            }
            return result
          }
          guard let file = self.snapshotFile() else {
            self.logger.notice("[widget-refresh] event=save id=\(diagnosticID, privacy: .public) outcome=container_unavailable")
            completion(.failed); return
          }
          snapshot.updatedAt = Date().timeIntervalSince1970 * 1000
          do {
            let output = try JSONEncoder().encode(snapshot)
            try output.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            self.logger.notice("[widget-refresh] event=save id=\(diagnosticID, privacy: .public) outcome=saved count=\(snapshot.runningCount ?? -1) updated_at_ms=\(Int64(snapshot.updatedAt ?? 0))")
            WidgetCenter.shared.reloadTimelines(ofKind: "BittyOrchestrator")
            self.logger.notice("[widget-refresh] event=reload id=\(diagnosticID, privacy: .public) outcome=requested")
            completion(.newData)
          } catch {
            self.logger.notice("[widget-refresh] event=save id=\(diagnosticID, privacy: .public) outcome=write_failed")
            completion(.failed)
          }
        }
      }
      self.activeRequest = task
      task.resume()
      // URLRequest.timeoutInterval is an inactivity timeout; enforce an overall background deadline too.
      self.queue.asyncAfter(deadline: .now() + 22) {
        if self.revision == startedRevision && self.activeRequest?.taskIdentifier == task.taskIdentifier {
          self.logger.notice("[widget-refresh] event=refresh id=\(diagnosticID, privacy: .public) outcome=deadline")
          task.cancel()
        }
      }
    }
  }

  private func snapshotFile() -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "BittyWidgetAppGroup") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
    return container.appendingPathComponent("widget-snapshot.json")
  }

  private func invalidateSnapshot() {
    if let file = snapshotFile() { try? FileManager.default.removeItem(at: file) }
    WidgetCenter.shared.reloadTimelines(ofKind: "BittyOrchestrator")
    logger.notice("[widget-refresh] event=cache outcome=invalidated")
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    BittyRunnerTLS.shared().handle(challenge, completion: completionHandler)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    // An authenticated snapshot endpoint never needs a redirect (including to a Cloudflare login).
    completionHandler(nil)
  }
}
