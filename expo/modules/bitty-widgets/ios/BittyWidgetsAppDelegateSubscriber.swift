import ExpoModulesCore
import UIKit
import WidgetKit

public class BittyWidgetsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    guard userInfo["bittyWidgetRefresh"] as? Int == 1 else { completionHandler(.noData); return }
    guard application.applicationState != .active else { completionHandler(.noData); return }
    WidgetCenter.shared.getCurrentConfigurations { result in
      guard case .success(let widgets) = result,
        widgets.contains(where: { $0.kind == "BittyOrchestrator" }) else { completionHandler(.noData); return }
      BittyWidgetSnapshotStore.shared.refresh(completion: completionHandler)
    }
  }
}
