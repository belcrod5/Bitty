import ExpoModulesCore

public class BittyRunnerTLSAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication,
      didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    BittyRunnerTLS.install()
    return true
  }
}
