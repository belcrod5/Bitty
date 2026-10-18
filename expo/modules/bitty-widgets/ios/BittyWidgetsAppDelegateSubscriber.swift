import ExpoModulesCore
import UIKit
import WidgetKit
import OSLog

public class BittyWidgetsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private let logger = Logger(subsystem: "app.bitty.widgets", category: "refresh")
  public func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    let aps = userInfo["aps"] as? [String: Any]
    let diagnosticID = UUID().uuidString
    let silent = userInfo["bittyWidgetRefresh"] as? Int == 1
    logger.notice("[widget-refresh] event=received id=\(diagnosticID, privacy: .public) state=\(application.applicationState.rawValue) silent=\(silent)")
    guard aps?["content-available"] as? Int == 1 || userInfo["bittyWidgetRefresh"] as? Int == 1 else {
      logger.notice("[widget-refresh] event=notification id=\(diagnosticID, privacy: .public) outcome=ignored")
      completionHandler(.noData); return
    }
    WidgetCenter.shared.getCurrentConfigurations { result in
      guard case .success(let widgets) = result else {
        self.logger.notice("[widget-refresh] event=notification id=\(diagnosticID, privacy: .public) outcome=configurations_failed")
        completionHandler(.noData); return
      }
      guard widgets.contains(where: { $0.kind == "BittyOrchestrator" }) else {
        self.logger.notice("[widget-refresh] event=notification id=\(diagnosticID, privacy: .public) outcome=no_widget")
        completionHandler(.noData); return
      }
      BittyWidgetSnapshotStore.shared.refresh(diagnosticID: diagnosticID, completion: completionHandler)
    }
  }
}
