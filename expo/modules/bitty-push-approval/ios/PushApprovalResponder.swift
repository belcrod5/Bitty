import Foundation
import UIKit
import UserNotifications

// POSTs the approve/deny decision to the runner entirely natively, so it works while the app
// stays in the background -- including a cold background launch of a previously killed app.
// expo-notifications' NotificationCenterManager invokes the system completionHandler
// immediately, so a UIBackgroundTask assertion is what actually keeps the process alive until
// the request settles (iOS grants roughly 30 seconds, far more than one HTTP round-trip).
// Mirrors the JS pushApprovalActions.ts respond path: same endpoint, bearer auth, optional
// Cloudflare Access headers, and the same local-notification fallback on failure.
// Never logs tokens or header values.
final class PushApprovalResponder {
  static let shared = PushApprovalResponder()

  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  func respond(approvalId: String, approved: Bool) {
    let lock = NSLock()
    var settled = false
    var inFlightTask: URLSessionDataTask?
    var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    // Exactly-once terminal path shared by the HTTP completion and the background-task
    // expiration handler: whichever runs first wins and the other becomes a no-op, so the
    // failure notification can never fire twice (an expiration-cancelled task still invokes
    // its completion handler, with NSURLErrorCancelled, which lands here and is ignored).
    func settle(failed: Bool, cancelInFlight: Bool) {
      lock.lock()
      let isFirst = !settled
      settled = true
      let task = inFlightTask
      lock.unlock()
      guard isFirst else { return }
      if cancelInFlight {
        NSLog("[push-approval] background task expired; cancelling in-flight respond")
        task?.cancel()
      }
      if failed {
        Self.scheduleFailureNotification()
      }
      // endBackgroundTask is documented as safe to call from any thread.
      if backgroundTask != .invalid {
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
      }
    }

    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "bitty.pushApprovalRespond") {
      // iOS is about to suspend the app: abort the request and tell the user it failed.
      settle(failed: true, cancelInFlight: true)
    }

    guard let request = buildRequest(approvalId: approvalId, approved: approved) else {
      NSLog("[push-approval] runner url or token unavailable; cannot respond")
      settle(failed: true, cancelInFlight: false)
      return
    }

    let task = session.dataTask(with: request) { _, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if error != nil || status < 200 || status >= 300 {
        NSLog("[push-approval] respond failed status=%d hasError=%d", status, error == nil ? 0 : 1)
        settle(failed: true, cancelInFlight: false)
      } else {
        NSLog("[push-approval] respond ok approved=%d", approved ? 1 : 0)
        settle(failed: false, cancelInFlight: false)
      }
    }
    // If the assertion expired before the request even started, do not fire it now.
    lock.lock()
    inFlightTask = task
    let expiredBeforeStart = settled
    lock.unlock()
    if expiredBeforeStart {
      task.cancel()
    } else {
      task.resume()
    }
  }

  private func buildRequest(approvalId: String, approved: Bool) -> URLRequest? {
    let runnerUrl = PushApprovalConfigStore.readRunnerUrl()
    let token = PushApprovalConfigStore.readSecureStoreValue(PushApprovalConfigStore.runnerTokenKey)
    guard !runnerUrl.isEmpty, !token.isEmpty else {
      return nil
    }
    let base = runnerUrl.hasSuffix("/") ? String(runnerUrl.dropLast()) : runnerUrl
    guard let encodedId = approvalId.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
      let url = URL(string: "\(base)/push/approvals/\(encodedId)/respond") else {
      return nil
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let cfClientId = PushApprovalConfigStore.readSecureStoreValue(PushApprovalConfigStore.cloudflareAccessClientIdKey)
    let cfClientSecret = PushApprovalConfigStore.readSecureStoreValue(PushApprovalConfigStore.cloudflareAccessClientSecretKey)
    if !cfClientId.isEmpty && !cfClientSecret.isEmpty {
      request.setValue(cfClientId, forHTTPHeaderField: "CF-Access-Client-Id")
      request.setValue(cfClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["approved": approved])
    return request
  }

  static func scheduleFailureNotification() {
    let content = UNMutableNotificationContent()
    content.title = "承認の送信に失敗しました"
    content.body = "アプリを開いて再度お試しください。"
    content.sound = .default
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }
}
