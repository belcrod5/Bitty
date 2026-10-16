import AppIntents
import Foundation
import UIKit

private enum VoiceOrchestratorStore {
  static func all() -> [VoiceOrchestratorEntity] {
    let fallback = [VoiceOrchestratorEntity(id: "main", name: "メイン")]
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
      let data = try? Data(contentsOf: documents.appendingPathComponent("bitty-settings.json")),
      let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let runnerUrl = settings["runnerUrl"] as? String,
      let snapshot = settings["siriVoiceOrchestrators"] as? [String: Any],
      snapshot["runnerUrl"] as? String == runnerUrl,
      let records = snapshot["orchestrators"] as? [[String: String]] else { return fallback }
    let entities = records.compactMap { record -> VoiceOrchestratorEntity? in
      guard let id = record["id"], let name = record["name"], !name.isEmpty,
        id.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil else { return nil }
      return VoiceOrchestratorEntity(id: id, name: name)
    }
    return entities.isEmpty ? fallback : entities
  }
}

struct VoiceOrchestratorEntity: AppEntity {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "話す相手")
  static var defaultQuery = VoiceOrchestratorQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

  init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

struct VoiceOrchestratorQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [VoiceOrchestratorEntity] {
    VoiceOrchestratorStore.all().filter { identifiers.contains($0.id) }
  }

  func entities(matching string: String) async throws -> [VoiceOrchestratorEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return [] }
    return VoiceOrchestratorStore.all().filter {
      $0.name.localizedStandardContains(query) || $0.id.localizedStandardContains(query)
    }
  }

  func suggestedEntities() async throws -> [VoiceOrchestratorEntity] {
    VoiceOrchestratorStore.all()
  }
}

struct StartBittyVoiceIntent: AppIntent {
  static var title: LocalizedStringResource = "Bittyで音声入力"
  static var description = IntentDescription("指定したオーケストレータとの音声会話を始めます。")
  static var openAppWhenRun = true

  @Parameter(title: "話す相手") var orchestrator: VoiceOrchestratorEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("\(\.$orchestrator)と話す")
  }

  func perform() async throws -> some IntentResult {
    guard let orchestrator else { throw $orchestrator.needsValueError("誰と話しますか？") }
    guard VoiceOrchestratorStore.all().contains(where: { $0.id == orchestrator.id }),
      let url = URL(string: "bitty://voice/\(orchestrator.id)") else {
      throw $orchestrator.needsValueError("誰と話しますか？")
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
      "\(\.$orchestrator)と\(.applicationName)で話す",
    ], shortTitle: "音声入力", systemImageName: "mic.fill")
  }
}
