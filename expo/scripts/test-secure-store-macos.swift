import Foundation
import Security

@main
struct SecureStoreMacOSKeychainTests {
  static func main() {
    guard let suite = ProcessInfo.processInfo.environment["BITTY_KEYCHAIN_TEST_SUITE"] else {
      fatalError("BITTY_KEYCHAIN_TEST_SUITE is required")
    }
    let services = ["legacy", "canonical", "both", "failure", "delete"].map { "\(suite).\($0)" }

    testLegacyMigration(service: services[0])
    testCanonicalOnly(service: services[1])
    testCanonicalWins(service: services[2])
    testFailureKeepsLegacy(service: services[3])
    testDeleteItems(service: services[4])
    print("SecureStore macOS Keychain migration tests passed")
  }

  private static func testLegacyMigration(service: String) {
    let key = "runner-token"
    let legacy = query(service: service, key: key, account: Data(key.utf8))
    let canonical = query(service: service, key: key, account: key)
    add(query: legacy, value: "legacy")

    expectValue(
      SecureStoreMacOSKeychain.migrateItem(canonicalQuery: canonical, legacyQuery: legacy),
      "legacy"
    )
    expect(read(query: canonical) == "legacy", "legacy value was not migrated")
    expect(read(query: legacy) == nil, "legacy item remained after migration")
  }

  private static func testCanonicalOnly(service: String) {
    let key = "runner-token"
    let legacy = query(service: service, key: key, account: Data(key.utf8))
    let canonical = query(service: service, key: key, account: key)
    add(query: canonical, value: "canonical")

    expectValue(
      SecureStoreMacOSKeychain.migrateItem(canonicalQuery: canonical, legacyQuery: legacy),
      "canonical"
    )
    expect(read(query: canonical) == "canonical", "canonical item changed")
  }

  private static func testCanonicalWins(service: String) {
    let key = "runner-token"
    let legacy = query(service: service, key: key, account: Data(key.utf8))
    let canonical = query(service: service, key: key, account: key)
    add(query: legacy, value: "legacy")
    add(query: canonical, value: "canonical")

    expectValue(
      SecureStoreMacOSKeychain.migrateItem(canonicalQuery: canonical, legacyQuery: legacy),
      "canonical"
    )
    expect(read(query: canonical) == "canonical", "canonical value did not win")
    expect(read(query: legacy) == nil, "legacy duplicate was not removed")
  }

  private static func testFailureKeepsLegacy(service: String) {
    let key = "runner-token"
    let legacy = query(service: service, key: key, account: Data(key.utf8))
    var invalidCanonical = query(service: service, key: key, account: key)
    invalidCanonical.removeValue(forKey: kSecAttrAccount as String)
    invalidCanonical[kSecAttrLabel as String] = "missing-canonical-item"
    add(query: legacy, value: "legacy")

    switch SecureStoreMacOSKeychain.migrateItem(
      canonicalQuery: invalidCanonical,
      legacyQuery: legacy
    ) {
    case .failure:
      break
    case .missing, .value:
      fatalError("invalid migration did not fail")
    }
    expect(read(query: legacy) == "legacy", "failed migration removed the legacy item")
  }

  private static func testDeleteItems(service: String) {
    let key = "runner-token"
    let legacy = query(service: service, key: key, account: Data(key.utf8))
    let canonical = query(service: service, key: key, account: key)
    add(query: legacy, value: "legacy")
    add(query: canonical, value: "canonical")

    SecureStoreMacOSKeychain.deleteItems(matching: [canonical, legacy])

    expect(read(query: canonical) == nil, "canonical item was not deleted")
    expect(read(query: legacy) == nil, "legacy item was not deleted")
  }

  private static func query(service: String, key: String, account: Any) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: Data(key.utf8),
      kSecAttrAccount as String: account
    ]
  }

  private static func add(query: [String: Any], value: String) {
    var item = query
    item[kSecValueData as String] = Data(value.utf8)
    let status = SecItemAdd(item as CFDictionary, nil)
    expect(status == errSecSuccess, "SecItemAdd failed: \(status)")
  }

  private static func read(query: [String: Any]) -> String? {
    var search = query
    search[kSecMatchLimit as String] = kSecMatchLimitOne
    search[kSecReturnData as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(search as CFDictionary, &item)
    if status == errSecItemNotFound {
      return nil
    }
    expect(status == errSecSuccess, "SecItemCopyMatching failed: \(status)")
    guard let data = item as? Data else {
      fatalError("Keychain value was not Data")
    }
    return String(data: data, encoding: .utf8)
  }

  private static func expectValue(
    _ result: SecureStoreMacOSKeychain.MigrationResult,
    _ expected: String
  ) {
    guard case .value(let data) = result,
          String(data: data, encoding: .utf8) == expected else {
      fatalError("unexpected migration result")
    }
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      fatalError(message)
    }
  }
}
