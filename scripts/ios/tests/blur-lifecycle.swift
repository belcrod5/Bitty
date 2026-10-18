import UIKit

final class BlurLifecycleController: UIViewController {
  let fixed = BlurEffectView()
  let resized = BlurEffectView()
  let holder = UIView()
  var reopened: BlurEffectView?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .red
    fixed.frame = CGRect(x: 20, y: 80, width: 180, height: 100)
    fixed.intensity = 0.65
    fixed.tint = .light
    view.addSubview(fixed)

    // Match a native BlurView mounted before its absolute-fill layout arrives.
    holder.frame = CGRect(x: 20, y: 220, width: 0, height: 0)
    resized.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    resized.intensity = 0.65
    resized.tint = .light
    holder.addSubview(resized)
    view.addSubview(holder)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      guard self.fixed.effect != nil else { return self.finish("FAIL: fixed-size control never initialized") }
      self.holder.frame.size = CGSize(width: 180, height: 100)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        guard self.resized.bounds.size == self.holder.bounds.size else {
          return self.finish("FAIL: native autoresizing did not fill the holder")
        }
        guard self.resized.effect != nil else {
          return self.finish("FAIL: initially empty blur stayed uninitialized after layout")
        }
        self.holder.frame.size = CGSize(width: 240, height: 140)
        self.resized.tint = .dark
        self.resized.intensity = 0.8
        self.fixed.removeFromSuperview()
        let reopened = BlurEffectView()
        reopened.frame = CGRect(x: 20, y: 80, width: 180, height: 100)
        reopened.intensity = 0.65
        self.view.addSubview(reopened)
        self.reopened = reopened
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
          guard self.resized.effect != nil, self.reopened?.effect != nil,
                self.resized.bounds.size == self.holder.bounds.size else {
            return self.finish("FAIL: resize, prop update, or reopen lost the effect")
          }
          self.finish("PASS: fixed, zero-to-visible, resize, prop update, and reopen blur lifecycle")
        }
      }
    }
  }

  func finish(_ result: String) {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("result.txt")
    try! result.write(to: url, atomically: true, encoding: .utf8)
  }
}

@main final class BlurLifecycleApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = BlurLifecycleController()
    self.window = window
    window.makeKeyAndVisible()
    return true
  }
}
