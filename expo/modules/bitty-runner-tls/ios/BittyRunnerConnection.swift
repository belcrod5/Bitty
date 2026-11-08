import Foundation
import CryptoKit
import Security

// Reads the configuration the native responder needs without any JS involvement:
//
// - Non-secret settings come from the same JSON file the app persists via
//   useAppSettingsPersistenceController.ts: <Documents>/bitty-settings.json
//   (expo-file-system's documentDirectory is the app's Documents directory; the file name is
//   the shared SETTINGS_FILE_NAME constant in persistedSettingsFile.ts).
//
// - Secrets come from the Keychain entries written by expo-secure-store. The query shape
//   below replicates expo-secure-store/ios/SecureStoreModule.swift `query(with:options:requireAuthentication:)`
//   exactly: kSecClassGenericPassword items whose service is the default "app" plus a
//   ":no-auth" alias suffix (the app always calls setItemAsync without options, so
//   requireAuthentication is false), with the key utf8-encoded into BOTH kSecAttrGeneric and
//   kSecAttrAccount, and the value stored as utf8 data. The suffix-less "app" service is the
//   legacy location older expo-secure-store versions wrote to; it is checked second, mirroring
//   SecureStoreModule.get's fallback order.
public enum BittyRunnerConnection {
  static let settingsFileName = "bitty-settings.json"
  static let credentialRecordKey = "bitty.runnerCredentials.v3"

  private static func settingsSnapshot() -> [String: Any]? {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
      let data = try? Data(contentsOf: documents.appendingPathComponent(settingsFileName)),
      let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return settings
  }
  public static func readSettingsField(_ field: String) -> Any? { settingsSnapshot()?[field] }

  public struct Configuration: Equatable {
    fileprivate let runnerUrl: String
    fileprivate let configuredRunnerUrl: String
    fileprivate let token: String
    fileprivate let cloudflareUrl: String
    fileprivate let clientId: String
    fileprivate let clientSecret: String

    public var identity: String { BittyRunnerConnection.identity(runnerUrl: configuredRunnerUrl, runnerToken: token) }

    public func matches(runnerUrl: String, runnerToken: String) -> Bool {
      configuredRunnerUrl == runnerUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        && token == runnerToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func request(path: String, method: String = "GET", timeout: TimeInterval = 20) -> URLRequest? {
      guard path.hasPrefix("/"), !path.hasPrefix("//"),
        let url = URL(string: runnerUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path),
        let origin = URL(string: runnerUrl), BittyRunnerConnection.sameOrigin(url, origin) else { return nil }
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
      request.httpMethod = method
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
      if let cloudflareOrigin = URL(string: cloudflareUrl),
        !BittyRunnerTLS.shared().handlesURL(url), BittyRunnerConnection.sameOrigin(url, cloudflareOrigin),
        !clientId.isEmpty && !clientSecret.isEmpty {
        request.setValue(clientId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
      }
      return request
    }
  }

  public static func identity(runnerUrl: String, runnerToken: String) -> String {
    let text = runnerUrl.trimmingCharacters(in: .whitespacesAndNewlines) + "\0" + runnerToken.trimmingCharacters(in: .whitespacesAndNewlines)
    return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  public static func load() -> Configuration? {
    BittyRunnerTLS.install()
    // Take one settings snapshot and one atomic Keychain record. Old settings
    // paired with new credentials after a crash must fail closed.
    guard let settings = settingsSnapshot(),
      let data = readSecureStoreValueAtExactKey(credentialRecordKey).data(using: .utf8),
      let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (record["version"] as? Int) == 3,
      let scope = record["scope"] as? [String: String],
      let token = record["runnerToken"] as? String,
      token.range(of: "^bitty_session_v1\\.[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil,
      let clientId = record["cloudflareAccessClientId"] as? String,
      let clientSecret = record["cloudflareAccessClientSecret"] as? String else { return nil }
    let current = (settings["runnerUrl"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let localRaw = settings["localRunnerUrl"] as? String ?? ""
    let local = httpsOrigin(localRaw)
    let cloudflareRaw = settings["cloudflareRunnerUrl"] as? String
      ?? settings["tunnelRunnerUrl"] as? String ?? (current == localRaw ? "" : current)
    let cloudflare = httpsOrigin(cloudflareRaw)
    let selected = httpsOrigin(current)
    guard (!cloudflareRaw.isEmpty ? !cloudflare.isEmpty : true),
      (!localRaw.isEmpty ? !local.isEmpty : true),
      !selected.isEmpty, selected == local || selected == cloudflare,
      scope["cloudflareOrigin"] == cloudflare, scope["localOrigin"] == local else { return nil }
    let runnerUrl: String
    if selected == local, let url = URL(string: local), BittyRunnerTLS.shared().handlesURL(url) { runnerUrl = local }
    else if !cloudflare.isEmpty { runnerUrl = cloudflare }
    else { return nil }
    return Configuration(runnerUrl: runnerUrl, configuredRunnerUrl: current, token: token,
      cloudflareUrl: cloudflare, clientId: clientId, clientSecret: clientSecret)
  }

  static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
    return left.scheme?.lowercased() == right.scheme?.lowercased() &&
      left.host?.lowercased() == right.host?.lowercased() && (left.port ?? 443) == (right.port ?? 443)
  }

  private static func httpsOrigin(_ raw: String) -> String {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: value), components.scheme?.lowercased() == "https",
      let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil, components.path.isEmpty || components.path == "/" else { return "" }
    components.scheme = "https"; components.host = host.lowercased(); components.path = ""
    if components.port == 443 { components.port = nil }
    return components.string ?? ""
  }

  private static func readSecureStoreValueAtExactKey(_ key: String) -> String {
    let encodedKey = Data(key.utf8)
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrGeneric as String: encodedKey,
        kSecAttrAccount as String: encodedKey,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: kCFBooleanTrue as Any
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
        let data = item as? Data,
        let value = String(data: data, encoding: .utf8) {
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
    return ""
  }
}
