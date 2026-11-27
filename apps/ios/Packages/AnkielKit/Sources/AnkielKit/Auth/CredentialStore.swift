import Foundation
import Security
import Synchronization

/// Secret storage by key. The app uses the Keychain; tests and the probe use other stores.
public protocol CredentialStore: Sendable {
  func data(for key: String) throws -> Data?
  func set(_ data: Data, for key: String) throws
  func remove(_ key: String) throws
}

extension CredentialStore {
  public func value<T: Decodable>(_: T.Type, for key: String) throws -> T? {
    try data(for: key).map { try JSONDecoder().decode(T.self, from: $0) }
  }

  public func set(_ value: some Encodable, for key: String) throws {
    try set(try JSONEncoder().encode(value), for: key)
  }

  /// The installation's DPoP key, created on first use.
  public func dpopKey() throws -> DPoPKey {
    if let raw = try data(for: CredentialKeys.dpopKey) {
      return try DPoPKey(rawRepresentation: raw)
    }
    let key = DPoPKey()
    try set(key.rawRepresentation, for: CredentialKeys.dpopKey)
    return key
  }
}

public enum CredentialKeys {
  public static let dpopKey = "dpop-proof-key"
  public static func credential(_ environmentId: String) -> String { "credential.\(environmentId)" }
}

public final class InMemoryCredentialStore: CredentialStore {
  private let storage = Mutex<[String: Data]>([:])

  public init() {}

  public func data(for key: String) -> Data? { storage.withLock { $0[key] } }
  public func set(_ data: Data, for key: String) { storage.withLock { $0[key] = data } }
  public func remove(_ key: String) { storage.withLock { _ = $0.removeValue(forKey: key) } }
}

/// Generic-password items under one service, readable after first unlock, never synced.
public struct KeychainCredentialStore: CredentialStore {
  public let service: String

  public init(service: String) {
    self.service = service
  }

  public struct Failure: Error, Sendable, Hashable {
    public let status: OSStatus
  }

  public func data(for key: String) throws -> Data? {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw Failure(status: status) }
    return result as? Data
  }

  public func set(_ data: Data, for key: String) throws {
    let update = [kSecValueData as String: data]
    var status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var item = baseQuery(key)
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Failure(status: status) }
  }

  public func remove(_ key: String) throws {
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
  }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }
}
