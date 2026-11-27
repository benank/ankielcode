import Foundation

/// An open, ready session (socket up, first server config read). The supervisor owns its
/// lifetime; shell sync reads from it.
public protocol LiveSession: AnyObject, Sendable, ThreadItemSource {
  var initialConfig: ServerConfig { get }
  /// The route this session went through.
  var route: EnvironmentRoute { get }
  /// `server.probe`. Throws when the session does not answer.
  func probe() async throws
  /// Suspends until the session ends (socket closed, went silent, or the config stream ended),
  /// and says why.
  func ended() async -> String
  func subscribeShell(_ subscription: ShellSubscription) async throws -> RpcStream<ShellStreamItem>
  /// `GET /api/orchestration/shell`, the gzip HTTP fallback after `snapshot-required`.
  func loadShellSnapshot(_ subscription: ShellSubscription) async throws -> ShellHTTPSnapshot
  /// A unary RPC on this session (commands, searches, page reads).
  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as: Response.Type
  ) async throws -> Response
  /// A streaming RPC on this session (git actions).
  func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of: Item.Type
  ) async throws -> RpcStream<Item>
  /// `GET /api/auth/session`: the scopes this device holds (`permissions`, else legacy `scopes`).
  /// nil when the server does not say.
  func grantedScopes() async throws -> Set<String>?
  /// Config events after the first snapshot (provider and settings changes), for this session.
  var configUpdates: AsyncStream<ServerConfigEvent> { get }
  func close() async
}

extension LiveSession {
  public var configUpdates: AsyncStream<ServerConfigEvent> { AsyncStream { $0.finish() } }

  public func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of _: Item.Type
  ) async throws -> RpcStream<Item> {
    throw RpcError.connectionClosed("This session cannot stream.")
  }
}

/// What the supervisor needs from the outside world for one environment. The live implementation
/// verifies routes, renews tokens and opens sockets; tests script it.
public protocol EnvironmentLink: Sendable {
  /// One connect attempt across the environment's routes. Never retries on its own.
  func connect() async throws(ConnectionError) -> any LiveSession
  /// When the current credential must be renewed; nil when it never needs renewing (bearer).
  func credentialRenewalDate() async -> Date?
  /// Renews the credential in place (same server session, so open sockets stay up).
  func renewCredential() async throws(ConnectionError)
}

/// `OrchestrationV2ShellHttpSnapshot`: a shell snapshot plus the opaque identities token to pass
/// back as `knownProjectIdentities`.
public struct ShellHTTPSnapshot: Sendable, Decodable {
  public var snapshot: ShellSnapshot
  public var projectIdentities: String?

  public init(snapshot: ShellSnapshot, projectIdentities: String? = nil) {
    self.snapshot = snapshot
    self.projectIdentities = projectIdentities
  }

  enum CodingKeys: String, CodingKey { case projectIdentities }

  public init(from decoder: any Decoder) throws {
    snapshot = try ShellSnapshot(from: decoder)
    projectIdentities = try? decoder.container(keyedBy: CodingKeys.self)
      .decodeIfPresent(String.self, forKey: .projectIdentities)
  }
}
