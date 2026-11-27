import CryptoKit
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

  /// The installation's software DPoP key, created on first use. Sessions paired before Secure
  /// Enclave keys (and pairings where the enclave failed) stay bound to it.
  public func dpopKey() throws -> DPoPKey {
    if let raw = try data(for: CredentialKeys.dpopKey) {
      return try DPoPKey(rawRepresentation: raw)
    }
    let key = DPoPKey()
    try set(key.rawRepresentation, for: CredentialKeys.dpopKey)
    return key
  }

  /// The key an environment's session is bound to: the Secure Enclave key when it was paired with
  /// one, else the software key. A missing or unreadable enclave key throws (pair again).
  public func dpopKey(for environmentId: String, enclave: any EnclaveKeys = SystemEnclaveKeys()) throws -> DPoPKey {
    guard try data(for: CredentialKeys.keyKind(environmentId)).map({ String(decoding: $0, as: UTF8.self) }) == DPoPKeyKind.enclave.rawValue
    else { return try dpopKey() }
    guard let blob = try data(for: CredentialKeys.enclaveKey) else { throw EnclaveKeyError.missing }
    return try enclave.restore(blob)
  }

  /// The key a new pairing binds to: the installation's Secure Enclave key (created on first use)
  /// when the device has one, else the software key. Any enclave failure falls back.
  public func pairingKey(enclave: any EnclaveKeys = SystemEnclaveKeys()) throws -> DPoPKey {
    if enclave.isAvailable {
      do {
        if let blob = try data(for: CredentialKeys.enclaveKey) { return try enclave.restore(blob) }
        let key = try enclave.make()
        try set(key.rawRepresentation, for: CredentialKeys.enclaveKey)
        return key
      } catch {
        // The simulator, a failed enclave call or a lost blob: the software key still works.
      }
    }
    return try dpopKey()
  }

  /// Records which key `environmentId`'s new credential is bound to.
  public func bind(_ environmentId: String, to key: DPoPKey?) throws {
    if key?.isHardwareBacked == true {
      try set(Data(DPoPKeyKind.enclave.rawValue.utf8), for: CredentialKeys.keyKind(environmentId))
    } else {
      try remove(CredentialKeys.keyKind(environmentId))
    }
  }
}

public enum DPoPKeyKind: String, Sendable {
  case enclave = "secure-enclave"
}

public enum CredentialKeys {
  public static let dpopKey = "dpop-proof-key"
  /// The Secure Enclave key's blob (useless off this device).
  public static let enclaveKey = "dpop-enclave-key"
  public static func credential(_ environmentId: String) -> String { "credential.\(environmentId)" }
  /// Which key the environment's credential is bound to; absent means the software key.
  public static func keyKind(_ environmentId: String) -> String { "dpop-key-kind.\(environmentId)" }
}

public enum EnclaveKeyError: Error, Sendable {
  case missing
}

/// Makes and restores Secure Enclave keys; tests inject failures and fakes.
public protocol EnclaveKeys: Sendable {
  var isAvailable: Bool { get }
  func make() throws -> DPoPKey
  func restore(_ blob: Data) throws -> DPoPKey
}

/// The device's Secure Enclave. Keys sign without user presence once the device has been
/// unlocked after a restart, so background renewals and notification answers keep working.
public struct SystemEnclaveKeys: EnclaveKeys {
  public init() {}

  public var isAvailable: Bool { SecureEnclave.isAvailable }

  public func make() throws -> DPoPKey {
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error)
    else { throw error!.takeRetainedValue() as any Error }
    return DPoPKey(enclave: try SecureEnclave.P256.Signing.PrivateKey(accessControl: access))
  }

  public func restore(_ blob: Data) throws -> DPoPKey {
    DPoPKey(enclave: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob))
  }
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
