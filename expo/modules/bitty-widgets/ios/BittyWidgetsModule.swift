import ExpoModulesCore
import WidgetKit
import UIKit

public class BittyWidgetsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BittyWidgets")
    AsyncFunction("setSnapshot") { (json: String) in
      guard let group = Bundle.main.object(forInfoDictionaryKey: "BittyWidgetAppGroup") as? String,
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
        let data = json.data(using: .utf8), data.count <= 16_000_000,
        var snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "BittyWidgets", code: 1, userInfo: [NSLocalizedDescriptionKey: "Widget App Group unavailable"])
      }
      // Re-encode icons at widget size; the extension never loads network URLs or full-size photos.
      if let records = snapshot["orchestrators"] as? [[String: Any]] {
        snapshot["orchestrators"] = records.prefix(100).map { record in
          var result = record
          result["icon"] = ""
          if let icon = record["icon"] as? String, icon.hasPrefix("data:image/"),
            let comma = icon.firstIndex(of: ","), let bytes = Data(base64Encoded: String(icon[icon.index(after: comma)...])),
            bytes.count <= 1_100_000, let image = UIImage(data: bytes) {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 96), format: format)
            result["icon"] = renderer.pngData { _ in image.draw(in: CGRect(x: 0, y: 0, width: 96, height: 96)) }.base64EncodedString()
          }
          return result
        }
      }
      snapshot["updatedAt"] = Date().timeIntervalSince1970 * 1000
      let output = try JSONSerialization.data(withJSONObject: snapshot)
      try output.write(to: container.appendingPathComponent("widget-snapshot.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      WidgetCenter.shared.reloadTimelines(ofKind: "BittyOrchestrator")
    }
  }
}
