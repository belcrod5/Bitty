import Foundation
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
    return (readSettingsField("runnerUrl") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func readFaceIdRequiredForApproval() -> Bool {
    return (readSettingsField("faceIdRequiredForApproval") as? Bool) ?? false
  }

  static func readSecureStoreValue(_ key: String) -> String {
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
