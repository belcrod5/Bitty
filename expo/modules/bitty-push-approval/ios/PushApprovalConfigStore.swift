import Foundation
import Security
import BittyRunnerTLS

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
enum PushApprovalConfigStore {
  static let settingsFileName = "bitty-settings.json"
  static let runnerTokenKey = "bitty.runnerToken"
  static let cloudflareAccessClientIdKey = "bitty.cloudflareAccessClientId"
  static let cloudflareAccessClientSecretKey = "bitty.cloudflareAccessClientSecret"

  static func readSettingsField(_ field: String) -> Any? {
    guard let documentsUrl = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return nil
    }
    let fileUrl = documentsUrl.appendingPathComponent(settingsFileName)
    guard let data = try? Data(contentsOf: fileUrl),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    return parsed[field]
  }

  static func readRunnerUrl() -> String {
    BittyRunnerTLS.install()
    let current = (readSettingsField("runnerUrl") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let configuredCloudflare = readSettingsField("cloudflareRunnerUrl") ?? readSettingsField("tunnelRunnerUrl")
    if let raw = configuredCloudflare as? String, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        httpsOrigin(raw).isEmpty { return "" }
    if let url = URL(string: current), BittyRunnerTLS.shared().handlesURL(url) {
      return current
    }
    let cloudflare = readCloudflareRunnerUrl()
    if !cloudflare.isEmpty { return cloudflare }
    let local = (readSettingsField("localRunnerUrl") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    // A formerly-selected LAN URL is not a fallback when its trust is missing.
    if current == local { return "" }
    return httpsOrigin(current)
  }

  static func readCloudflareRunnerUrl() -> String {
    let configured = readSettingsField("cloudflareRunnerUrl") ?? readSettingsField("tunnelRunnerUrl")
    if let configured = configured as? String, !configured.isEmpty { return httpsOrigin(configured) }
    let runner = readSettingsField("runnerUrl") as? String ?? ""
    let local = readSettingsField("localRunnerUrl") as? String ?? ""
    return runner == local ? "" : httpsOrigin(runner)
  }

  static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
    return left.scheme?.lowercased() == right.scheme?.lowercased() &&
      left.host?.lowercased() == right.host?.lowercased() && (left.port ?? 443) == (right.port ?? 443)
  }

  private static func httpsOrigin(_ raw: String) -> String {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: value), url.scheme?.lowercased() == "https", url.host != nil,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/" else { return "" }
    return value
  }

  static func readFaceIdRequiredForApproval() -> Bool {
    return (readSettingsField("faceIdRequiredForApproval") as? Bool) ?? false
  }

  // Credentials migrated to AFTER_FIRST_UNLOCK accessibility live under "<key>.v2"
  // (see secureRunnerCredentials.ts); the suffix-less key is the pre-migration
  // location and is checked second, mirroring the JS readField fallback order.
  static func readSecureStoreValue(_ key: String) -> String {
    let v2Value = readSecureStoreValueAtExactKey("\(key).v2")
    if !v2Value.isEmpty {
      return v2Value
    }
    return readSecureStoreValueAtExactKey(key)
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
