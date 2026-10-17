import AppIntents
import Foundation
import UIKit

private enum VoiceOrchestratorStore {
  private static func all() -> [(id: String, name: String)] {
    let fallback = [(id: "main", name: "メイン")]
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
      let data = try? Data(contentsOf: documents.appendingPathComponent("bitty-settings.json")),
      let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let runnerUrl = settings["runnerUrl"] as? String,
      let snapshot = settings["siriVoiceOrchestrators"] as? [String: Any],
      snapshot["runnerUrl"] as? String == runnerUrl,
      let records = snapshot["orchestrators"] as? [[String: String]] else { return fallback }
    let orchestrators = records.compactMap { record -> (id: String, name: String)? in
      guard let id = record["id"], let name = record["name"], !name.isEmpty,
        id.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil else { return nil }
      return (id: id, name: name)
    }
    return orchestrators.isEmpty ? fallback : orchestrators
  }

  static func id(matching spokenName: String) -> String? {
    let name = spokenName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return nil }
    let normalizedName = name.applyingTransform(.hiraganaToKatakana, reverse: false) ?? name
    let orchestrators = all()
    let exact = orchestrators.filter {
      ($0.name.applyingTransform(.hiraganaToKatakana, reverse: false) ?? $0.name)
        .localizedStandardCompare(normalizedName) == .orderedSame
    }
    if exact.count == 1 { return exact[0].id }
    let partial = orchestrators.filter {
      ($0.name.applyingTransform(.hiraganaToKatakana, reverse: false) ?? $0.name)
        .localizedStandardContains(normalizedName) || $0.id.localizedStandardContains(name)
    }
    return partial.count == 1 ? partial[0].id : nil
  }
}

struct StartBittyVoiceIntent: AppIntent {
  static var title: LocalizedStringResource = "Bittyで音声入力"
  static var description = IntentDescription("指定したオーケストレータとの音声会話を始めます。")
  static var openAppWhenRun = true

  @Parameter(title: "話す相手") var orchestratorName: String?

  static var parameterSummary: some ParameterSummary {
    Summary("\(\.$orchestratorName)と話す")
  }

  func perform() async throws -> some IntentResult {
    guard let orchestratorName, let id = VoiceOrchestratorStore.id(matching: orchestratorName),
      let url = URL(string: "bitty://voice/\(id)") else {
      throw $orchestratorName.needsValueError("誰と話しますか？")
    }
    await UIApplication.shared.open(url)
    return .result()
  }
}

struct BittyVoiceShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: StartBittyVoiceIntent(), phrases: [
      "\(.applicationName)で音声入力",
      "\(.applicationName)で会話",
      "\(.applicationName)で通話",
      "\(.applicationName)で電話",
    ], shortTitle: "音声入力", systemImageName: "mic.fill")
  }
}
