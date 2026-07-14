import ExpoModulesCore
import EXNotifications

// Registers the native approval-action responder with expo-notifications' shared
// NotificationCenterManager. Runs in didFinishLaunching, which iOS guarantees to complete
// before a notification response is delivered on a cold (background) launch, so the
// responder never misses an action press. Touching NotificationCenterManager.shared here
// also forces it to install itself as the UNUserNotificationCenter delegate early.
public class BittyPushApprovalAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(PushApprovalNotificationDelegate.shared)
    return true
  }
}
