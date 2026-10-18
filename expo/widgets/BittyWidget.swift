import AppIntents
import SwiftUI
import WidgetKit
import UIKit

struct WidgetOrchestrator: Codable, Identifiable {
  let id: String
  let name: String
  let icon: String
}

struct WidgetSnapshot: Decodable {
  var connected: Bool
  var orchestrators: [WidgetOrchestrator]
  var selectedId: String
  var runningCount: Int?
  var overview: String
  var overviewFetchedAt: Double
  var fiveHourRemaining: Int?
  var weeklyRemaining: Int?
  var usageLimitReached: Bool
  var usageFetchedAt: Double
  var updatedAt: Double

  static let empty = WidgetSnapshot(connected: false, orchestrators: [], selectedId: "", runningCount: nil,
    overview: "", overviewFetchedAt: 0, fiveHourRemaining: nil, weeklyRemaining: nil,
    usageLimitReached: false, usageFetchedAt: 0, updatedAt: 0)

  static func load() -> WidgetSnapshot {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "BittyWidgetAppGroup") as? String,
      let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
      let data = try? Data(contentsOf: directory.appendingPathComponent("widget-snapshot.json")),
      data.count <= 8_000_000, let snapshot = try? JSONDecoder().decode(Self.self, from: data) else { return .empty }
    return snapshot
  }
}

struct OrchestratorEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "話す相手"
  static var defaultQuery = OrchestratorQuery()
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct OrchestratorQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [OrchestratorEntity] {
    WidgetSnapshot.load().orchestrators.filter { identifiers.contains($0.id) }
      .map { OrchestratorEntity(id: $0.id, name: $0.name) }
  }
  func suggestedEntities() async throws -> [OrchestratorEntity] {
    WidgetSnapshot.load().orchestrators.map { OrchestratorEntity(id: $0.id, name: $0.name) }
  }
  func defaultResult() async -> OrchestratorEntity? {
    let snapshot = WidgetSnapshot.load()
    return snapshot.orchestrators.first(where: { $0.id == snapshot.selectedId })
      .map { OrchestratorEntity(id: $0.id, name: $0.name) }
  }
}

struct OrchestratorConfiguration: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Bitty オーケストレーター"
  static var description = IntentDescription("話しかける相手を選べます。To Do と実行数は全体の情報です。")
  @Parameter(title: "話す相手") var orchestrator: OrchestratorEntity?
}

struct BittyEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot
  let orchestratorId: String?
  var recipient: WidgetOrchestrator? {
    snapshot.orchestrators.first { $0.id == (orchestratorId ?? snapshot.selectedId) }
  }
}

struct BittyProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> BittyEntry { BittyEntry(date: .now, snapshot: .empty, orchestratorId: nil) }
  func snapshot(for configuration: OrchestratorConfiguration, in context: Context) async -> BittyEntry {
    BittyEntry(date: .now, snapshot: .load(), orchestratorId: configuration.orchestrator?.id)
  }
  func timeline(for configuration: OrchestratorConfiguration, in context: Context) async -> Timeline<BittyEntry> {
    let entry = BittyEntry(date: .now, snapshot: .load(), orchestratorId: configuration.orchestrator?.id)
    // This only re-reads app snapshots. The extension never holds credentials or starts a Runner connection.
    let timestamps: Set<Double> = [entry.snapshot.updatedAt, entry.snapshot.usageFetchedAt, entry.snapshot.overviewFetchedAt]
    let expirations: [Date] = timestamps.filter { $0 > 0 }.map { Date(timeIntervalSince1970: $0 / 1000 + 900) }
      .filter { $0 > entry.date }.sorted()
    var entries = [entry]
    for date in expirations { entries.append(BittyEntry(date: date, snapshot: entry.snapshot, orchestratorId: entry.orchestratorId)) }
    return Timeline(entries: entries, policy: .after(.now.addingTimeInterval(30 * 60)))
  }
}


private let mint = Color(red: 0.38, green: 0.94, blue: 0.79)
private let ink = Color(red: 0.035, green: 0.055, blue: 0.105)
private let muted = Color(red: 0.61, green: 0.69, blue: 0.78)

struct BittyWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: BittyEntry
  private var small: Bool { family == .systemSmall }
  private var large: Bool { family == .systemLarge }
  private var snapshot: WidgetSnapshot { entry.snapshot }
  private var stale: Bool { !snapshot.connected || snapshot.updatedAt == 0 || entry.date.timeIntervalSince1970 * 1000 - snapshot.updatedAt >= 15 * 60_000 }
  private var voiceURL: URL {
    if let id = entry.recipient?.id, id.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil {
      return URL(string: "bitty://voice/\(id)")!
    }
    return URL(string: "bitty://")!
  }
  private var background: some View {
    LinearGradient(colors: [Color(red: 0.075, green: 0.12, blue: 0.19), ink], startPoint: .topLeading, endPoint: .bottomTrailing)
      .overlay(alignment: .topTrailing) {
        Circle().fill(mint.opacity(0.07)).frame(width: 180, height: 180).blur(radius: 28).offset(x: 70, y: -90)
      }
  }

  var body: some View {
    content.containerBackground(for: .widget) { background }
    .widgetURL(small ? voiceURL : URL(string: "bitty://")!)
    .environment(\.colorScheme, .dark)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: small ? 4 : 12) {
      HStack(spacing: 9) {
        avatar
        VStack(alignment: .leading, spacing: 3) {
          Text(small ? "BITTY" : "BITTY / ORCHESTRATOR").font(.system(size: small ? 7 : 8, weight: .bold, design: .monospaced))
            .tracking(1.2).foregroundStyle(mint)
          Text(entry.recipient?.name ?? "Bitty を開いて設定")
            .font(.system(size: small ? 14 : 17, weight: .semibold)).foregroundStyle(.white)
            .lineLimit(1).minimumScaleFactor(0.75).privacySensitive()
        }
        Spacer(minLength: 0)
        if !small { voiceButton }
      }
      if small {
        Spacer(minLength: 0)
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Image(systemName: "person.2.fill").font(.system(size: 11)).foregroundStyle(mint)
          Text(snapshot.connected ? snapshot.runningCount.map(String.init) ?? "--" : "--")
            .font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(stale ? muted : .white)
          Text("全体で実行中").font(.system(size: 9)).foregroundStyle(muted)
        }
        HStack(spacing: 10) {
          limit(label: "5h", value: snapshot.fiveHourRemaining)
          limit(label: "週", value: snapshot.weeklyRemaining)
        }
        voiceButton
        freshness
      } else {
        HStack(spacing: 7) {
          Text("TO DO").font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.5).foregroundStyle(mint)
          Text("全体の概要").font(.system(size: 9)).foregroundStyle(muted)
          Spacer()
          freshness
        }
        VStack(alignment: .leading, spacing: large ? 10 : 5) {
          let rows = snapshot.overview.split(separator: "\n").map(String.init)
          if rows.isEmpty {
            Text(snapshot.updatedAt == 0 ? "アプリを開いて最新の情報を同期" : "表示できる概要がありません")
              .font(.system(size: 12)).foregroundStyle(muted).lineLimit(2)
          } else {
            ForEach(Array(rows.prefix(large ? 6 : 2).enumerated()), id: \.offset) { index, text in
              HStack(alignment: .top, spacing: 7) {
                RoundedRectangle(cornerRadius: 2).fill(mint.opacity(0.8)).frame(width: 3, height: 12).padding(.top, 2)
                Text(text).font(.system(size: large ? 14 : 12, weight: .medium)).foregroundStyle(.white.opacity(0.91))
                  .lineLimit(large ? 2 : 1).privacySensitive()
              }
            }
            if large && rows.count > 6 { Text("ほか \(rows.count - 6) 件").font(.system(size: 10)).foregroundStyle(muted) }
          }
        }
        Spacer(minLength: 0)
        Rectangle().fill(.white.opacity(0.1)).frame(height: 1)
        HStack(spacing: 16) {
          HStack(spacing: 5) {
            Image(systemName: "person.2.fill").foregroundStyle(mint)
            Text(snapshot.connected ? snapshot.runningCount.map(String.init) ?? "--" : "--").fontWeight(.semibold).foregroundStyle(.white)
            Text("実行中").foregroundStyle(muted)
          }.font(.system(size: 11)).accessibilityLabel("\(stale ? "最終同期時の" : "全体の")実行中エージェント \(snapshot.connected ? snapshot.runningCount.map(String.init) ?? "不明" : "不明")")
          Spacer(minLength: 0)
          limit(label: "5h", value: snapshot.fiveHourRemaining)
          limit(label: "週", value: snapshot.weeklyRemaining)
        }
        if large {
          HStack {
            Text("利用上限までの残り").font(.system(size: 9)).foregroundStyle(muted)
            Spacer()
            if snapshot.usageFetchedAt > 0 {
              HStack(spacing: 3) {
                Text("取得")
                Text(Date(timeIntervalSince1970: snapshot.usageFetchedAt / 1000), style: .time)
              }.font(.system(size: 9)).foregroundStyle(muted)
            }
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var avatar: some View {
    Group {
      if let icon = entry.recipient?.icon, let data = Data(base64Encoded: icon), let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Text(entry.recipient?.name.first.map(String.init) ?? "B")
          .font(.system(size: 18, weight: .semibold, design: .rounded)).foregroundStyle(mint)
          .frame(maxWidth: .infinity, maxHeight: .infinity).background(mint.opacity(0.12))
      }
    }
    .frame(width: small ? 30 : 36, height: small ? 30 : 36).clipShape(Circle())
    .overlay(Circle().stroke(mint.opacity(0.35), lineWidth: 1)).privacySensitive().accessibilityHidden(true)
  }

  private var voiceButton: some View {
    Link(destination: voiceURL) {
      HStack(spacing: 5) {
        Image(systemName: "mic.fill").font(.system(size: small ? 11 : 13, weight: .semibold))
        Text(entry.recipient == nil ? "アプリを開く" : "話しかける").font(.system(size: 11, weight: .bold))
      }
      .foregroundStyle(ink).frame(maxWidth: small ? .infinity : nil)
      .padding(.horizontal, small ? 8 : 13).padding(.vertical, small ? 7 : 9)
      .background(mint, in: Capsule())
    }
    .accessibilityLabel(entry.recipient.map { "\($0.name)と音声会話。アプリを開いて録音を開始" } ?? "Bitty を開いて設定")
  }

  private func limit(label: String, value: Int?) -> some View {
    let known = snapshot.connected && snapshot.usageFetchedAt > 0
    let usageStale = entry.date.timeIntervalSince1970 * 1000 - snapshot.usageFetchedAt >= 15 * 60_000
    let percent = known ? value : nil
    let color = percent == 0 || (known && snapshot.usageLimitReached) ? Color(red: 1, green: 0.48, blue: 0.45)
      : percent.map { $0 <= 10 } == true ? Color.orange : mint
    return VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 4) {
        Text(label).foregroundStyle(muted)
        if known && usageStale { Image(systemName: "clock").font(.system(size: 7)).foregroundStyle(muted) }
        Text(percent.map { "\($0)%" } ?? (known && snapshot.usageLimitReached ? "上限" : "--%"))
          .fontWeight(.semibold).foregroundStyle(color).monospacedDigit()
      }
      Capsule().fill(.white.opacity(0.12)).frame(width: small ? 42 : 48, height: 2)
        .overlay(alignment: .leading) {
          Capsule().fill(color).frame(width: (small ? 42 : 48) * CGFloat(percent ?? 0) / 100, height: 2)
        }
    }.font(.system(size: small ? 10 : 11))
      .accessibilityLabel("\(label == "5h" ? "5時間" : "週間")の残り \(percent.map { "\($0)パーセント" } ?? "不明")\(usageStale ? "。最終取得時の値、更新待ち" : "")")
  }

  private var freshness: some View {
    HStack(spacing: 4) {
      Circle().fill(stale ? muted : mint).frame(width: 4, height: 4)
      let fetchedAt = small ? snapshot.updatedAt : snapshot.overviewFetchedAt
      if fetchedAt == 0 { Text("未同期") }
      else if stale || entry.date.timeIntervalSince1970 * 1000 - fetchedAt >= 15 * 60_000 {
        Text("更新待ち")
        Text(Date(timeIntervalSince1970: fetchedAt / 1000), style: .time)
      }
      else { Text(Date(timeIntervalSince1970: fetchedAt / 1000), style: .time) }
    }.font(.system(size: 8, design: .monospaced)).foregroundStyle(muted)
  }
}

@main
struct ConfigurableBittyWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "BittyOrchestrator", intent: OrchestratorConfiguration.self, provider: BittyProvider()) {
      BittyWidgetView(entry: $0)
    }
    .configurationDisplayName("Bitty オーケストレーター")
    .description("相手を選んで音声会話。全体の To Do・実行数・利用上限を確認。通知設定済みの場合はバックグラウンドでも同期します。")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
