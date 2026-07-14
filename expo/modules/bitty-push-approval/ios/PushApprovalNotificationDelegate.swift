import EXNotifications
import UIKit
import UserNotifications

// Decides which notification responses this module owns. Everything it does not own is left
// untouched (didReceive returns false), so expo-notifications' EmitterModule keeps forwarding
// events to JS exactly as before: default taps (session navigation), TURN_COMPLETED, and the
// Face-ID approve flow all stay in the JS layer.
//
// Ownership matrix (must stay in sync with pushApprovalNotifications.ts /
// pushApprovalActions.ts on the JS side, which skip the natively-owned cases):
//   - deny action:                     always handled natively (background, app stays closed)
//   - approve action, Face ID OFF:     handled natively (background, app stays closed)
//   - approve action, Face ID ON:      NOT handled natively; the action is registered with
//                                      opensAppToForeground=true and JS runs Face ID + respond
//   - default tap / other categories:  never handled natively
public final class PushApprovalNotificationDelegate: NSObject, NotificationDelegate {
  @objc public static let shared = PushApprovalNotificationDelegate()

  static let approvalCategory = "APPROVAL_REQUEST"
  static let approveAction = "approve"
  static let denyAction = "deny"

  public func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let content = response.notification.request.content
    guard content.categoryIdentifier == Self.approvalCategory else {
      return false
    }
    let approved: Bool
    switch response.actionIdentifier {
    case Self.approveAction:
      approved = true
    case Self.denyAction:
      approved = false
    default:
      // Default tap (open the app to the approval UI) belongs to the JS layer.
      return false
    }
    guard let approvalId = content.userInfo["approvalId"] as? String, !approvalId.isEmpty else {
      return false
    }
    if approved && PushApprovalConfigStore.readFaceIdRequiredForApproval() {
      // Approve must never be sent without authentication in this mode; the JS layer handles
      // it after the (foreground-opening) action launches the app. One gap: if the pressed
      // notification's category was registered while Face ID was still OFF, its approve
      // action is a background action, so the app never comes to the foreground and JS never
      // gets a chance to run Face ID -- both layers would silently drop the press. Detect
      // that (we are still in the background) and nudge the user to open the app instead.
      notifyOpenAppIfInBackground()
      return false
    }
    PushApprovalResponder.shared.respond(approvalId: approvalId, approved: approved)
    return true
  }

  private func notifyOpenAppIfInBackground() {
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState == .background else { return }
      let content = UNMutableNotificationContent()
      content.title = "アプリを開いて承認してください"
      content.body = "承認にはFace ID認証が必要です。"
      content.sound = .default
      let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      UNUserNotificationCenter.current().add(request)
    }
  }
}
