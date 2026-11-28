import Foundation
import Security

/// Computers paired in the React Native app, read from its Keychain (`expo-secure-store` items in
/// the RN app's access group, which only an app signed by the same team can list). Its DPoP key
/// comes along because its DPoP tokens are bound to it.
public struct RNAppImport: Sendable {
  public struct Environment: Sendable, Hashable {
    public var record: EnvironmentRecord
    public var credential: AccessCredential
  }

  public var environments: [Environment]
  /// The RN installation's P-256 private scalar (`DPoPKey(rawRepresentation:)`).
  public var dpopKey: Data?

  static let catalogKey = "ankielcode.connection-catalog.v1"
  static let dpopKeyKey = "ankielcode.cloud.dpop-proof-key"

  /// Reads both items from `accessGroup`; nil when the RN app saved nothing there.
  public static func read(accessGroup: String) -> RNAppImport? {
    guard let catalog = item(catalogKey, accessGroup: accessGroup) else { return nil }
    return try? RNAppImport(catalog: catalog, dpopJWK: item(dpopKeyKey, accessGroup: accessGroup))
  }

  /// `catalog` is `ConnectionCatalogDocument` JSON; SSH profiles and entries without a credential
  /// are skipped. A computer's further profiles become fallback routes.
  public init(catalog: Data, dpopJWK: Data?, importedAt: Date = .now) throws {
    let document = try JSONDecoder().decode(Catalog.self, from: catalog)
    let credentials = Dictionary(
      document.credentials.map { ($0.connectionId, $0.credential) }, uniquingKeysWith: { first, _ in first })
    let disabled = Set(document.disabledEnvironmentIds ?? [])
    var order: [String] = []
    var byEnvironment: [String: Environment] = [:]
    for profile in document.profiles where profile._tag == "BearerConnectionProfile" {
      guard let http = profile.httpBaseUrl.flatMap(URLComponents.init(string:)),
        let endpoint = EnvironmentEndpoint(http)
      else { continue }
      if var existing = byEnvironment[profile.environmentId] {
        guard !existing.record.routes.contains(where: { $0.endpoint == endpoint }) else { continue }
        existing.record.routes.append(EnvironmentRoute(endpoint: endpoint, learned: true))
        byEnvironment[profile.environmentId] = existing
        continue
      }
      guard let credential = credentials[profile.connectionId]?.accessCredential else { continue }
      var record = EnvironmentRecord(
        SavedEnvironment(
          environmentId: profile.environmentId, label: profile.label, endpoint: endpoint, serverVersion: "",
          pairedAt: importedAt))
      if disabled.contains(profile.environmentId) { record.enabled = false }
      order.append(profile.environmentId)
      byEnvironment[profile.environmentId] = Environment(record: record, credential: credential)
    }
    environments = order.compactMap { byEnvironment[$0] }
    dpopKey = try dpopJWK.map { try JSONDecoder().decode(PrivateJWK.self, from: $0) }
      .flatMap { Data(base64URLEncoded: $0.d) }
  }

  /// `expo-secure-store` keys items by service `app:no-auth` (`app` before SDK 50) and account.
  private static func item(_ key: String, accessGroup: String) -> Data? {
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
        kSecAttrAccount as String: Data(key.utf8), kSecAttrAccessGroup as String: accessGroup,
        kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var result: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
        return data
      }
    }
    return nil
  }

  private struct Catalog: Decodable {
    var profiles: [Profile]
    var credentials: [StoredCredential]
    var disabledEnvironmentIds: [String]?
  }

  private struct Profile: Decodable {
    var _tag: String
    var connectionId: String
    var environmentId: String
    var label: String
    var httpBaseUrl: String?
  }

  private struct StoredCredential: Decodable {
    var connectionId: String
    var credential: Credential
  }

  private struct Credential: Decodable {
    var _tag: String
    var token: String?
    var accessToken: String?
    var expiresAtEpochMs: Double?

    var accessCredential: AccessCredential? {
      switch _tag {
      case "BearerConnectionCredential": token.map { .bearer(token: $0) }
      case "DpopConnectionCredential":
        accessToken.map { .dpop(accessToken: $0, expiresAt: Date(timeIntervalSince1970: (expiresAtEpochMs ?? 0) / 1000)) }
      default: nil
      }
    }
  }

  private struct PrivateJWK: Decodable {
    var d: String
  }
}
