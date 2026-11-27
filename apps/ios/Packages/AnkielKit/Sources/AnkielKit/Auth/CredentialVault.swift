import Foundation

/// One environment's credential: loads it from the store, renews a DPoP token when due, and
/// serializes renewals so the live renewal loop, a connect and an HTTP request never renew twice.
public actor CredentialVault {
  public let environmentId: String
  private let connector: EnvironmentConnector
  private var renewal: Task<AccessCredential, any Error>?

  public init(environmentId: String, connector: EnvironmentConnector) {
    self.environmentId = environmentId
    self.connector = connector
  }

  public func stored() throws(ConnectionError) -> AccessCredential {
    guard let credential = try connector.loadCredential(environmentId) else { throw .credentialRejected }
    return credential
  }

  /// When the live renewal loop should renew; nil for bearer tokens.
  public func renewalDate() -> Date? {
    guard case .dpop(_, let expiresAt)? = try? stored() else { return nil }
    return expiresAt.addingTimeInterval(-60)
  }

  /// The stored credential, renewed first when it is within a minute of expiry.
  public func current(at endpoint: EnvironmentEndpoint) async throws(ConnectionError) -> AccessCredential {
    let credential = try stored()
    guard credential.needsRenewal() else { return credential }
    return try await renew(at: endpoint, replacing: credential.token)
  }

  /// Renews in place. `replacing` is the token the caller saw rejected: when another caller has
  /// already renewed past it, that newer token is returned without a second exchange.
  public func renew(at endpoint: EnvironmentEndpoint, replacing token: String? = nil) async throws(ConnectionError)
    -> AccessCredential
  {
    if let renewal {
      return try await Self.value(of: renewal)
    }
    let credential = try stored()
    if let token, credential.token != token { return credential }
    guard case .dpop = credential else { throw .credentialRejected }
    let connector = connector
    let environmentId = environmentId
    let task = Task { () throws -> AccessCredential in
      try await connector.renew(credential, environmentId: environmentId, endpoint: endpoint)
    }
    renewal = task
    defer { renewal = nil }
    return try await Self.value(of: task)
  }

  private static func value(of task: Task<AccessCredential, any Error>) async throws(ConnectionError)
    -> AccessCredential
  {
    do {
      return try await task.value
    } catch let error as ConnectionError {
      throw error
    } catch {
      throw .unreachable(EnvironmentConnector.describe(error))
    }
  }
}
