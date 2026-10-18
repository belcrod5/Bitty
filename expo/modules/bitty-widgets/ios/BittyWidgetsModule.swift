import ExpoModulesCore
import UIKit

public class BittyWidgetsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BittyWidgets")
    AsyncFunction("activateSource") { (runnerUrl: String, runnerToken: String) in
      DispatchQueue.main.async {
        guard UIApplication.shared.applicationState == .active else { return }
        BittyWidgetSnapshotStore.shared.activate(runnerUrl: runnerUrl, runnerToken: runnerToken)
      }
    }
    AsyncFunction("refreshSnapshot") { (runnerUrl: String, runnerToken: String, promise: Promise) in
      DispatchQueue.main.async {
        // React can start on a cold background push. It must never overwrite that background refresh.
        guard UIApplication.shared.applicationState == .active else { promise.resolve(false); return }
        BittyWidgetSnapshotStore.shared.refresh(expectedRunnerUrl: runnerUrl, expectedRunnerToken: runnerToken) {
          promise.resolve($0 == .newData)
        }
      }
    }
  }
}
