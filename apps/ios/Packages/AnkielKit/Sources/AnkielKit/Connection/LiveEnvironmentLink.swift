import Foundation
import Synchronization

/// The routes of one environment, shared between the registry (which saves learned routes) and
/// the link (which tries them).
public final class RouteBook: Sendable {
  private let state: Mutex<(routes: [EnvironmentRoute], lastUsed: String?)>

  public init(routes: [EnvironmentRoute], lastUsed: String? = nil) {
    state = Mutex((routes, lastUsed))
  }

  public var routes: [EnvironmentRoute] {
    get { state.withLock { $0.routes } }
    set { state.withLock { $0.routes = newValue } }
  }

  public var lastUsed: String? {
    get { state.withLock { $0.lastUsed } }
    set { state.withLock { $0.lastUsed = newValue } }
  }
}

/// The real `EnvironmentLink`: tries each route in order, each verified by its descriptor before
/// a credential goes out.
public struct LiveEnvironmentLink: EnvironmentLink {
  public let environmentId: String
  public let connector: EnvironmentConnector
  public let vault: CredentialVault
  public let routes: RouteBook

  public init(environmentId: String, connector: EnvironmentConnector, vault: CredentialVault, routes: RouteBook) {
    self.environmentId = environmentId
    self.connector = connector
    self.vault = vault
    self.routes = routes
  }

  public func connect() async throws(ConnectionError) -> any LiveSession {
    var pairedRouteError: ConnectionError?
    var lastError: ConnectionError?
    for route in RouteSelection.order(routes.routes, lastUsed: routes.lastUsed) {
      if Task.isCancelled { throw .timedOut }
      do {
        let session = try await connector.connect(environmentId: environmentId, endpoint: route.endpoint, vault: vault)
        routes.lastUsed = route.id
        return LiveSessionAdapter(session: session, route: route, connector: connector, vault: vault)
      } catch {
        switch error {
        case .credentialRejected, .clockSkew, .incompatibleProtocol:
          // The environment itself answered (its descriptor matched) and refused: decisive.
          throw error
        default:
          if !route.learned { pairedRouteError = error }
          lastError = error
        }
      }
    }
    throw pairedRouteError ?? lastError ?? .unreachable("No saved route.")
  }

  public func credentialRenewalDate() async -> Date? {
    await vault.renewalDate()
  }

  public func renewCredential() async throws(ConnectionError) {
    let endpoint = (routes.routes.first { $0.id == routes.lastUsed } ?? routes.routes.first)?.endpoint
    guard let endpoint else { throw .unreachable("No saved route.") }
    _ = try await vault.renew(at: endpoint)
  }
}

/// An `EnvironmentSession` as a `LiveSession`. Drains the config stream for the session's
/// lifetime (its end is the session's end).
final class LiveSessionAdapter: LiveSession {
  let session: EnvironmentSession
  let route: EnvironmentRoute
  private let connector: EnvironmentConnector
  private let vault: CredentialVault
  private let watcher: Task<String, Never>
  let configUpdates: AsyncStream<ServerConfigEvent>

  init(session: EnvironmentSession, route: EnvironmentRoute, connector: EnvironmentConnector, vault: CredentialVault) {
    self.session = session
    self.route = route
    self.connector = connector
    self.vault = vault
    let (updates, continuation) = AsyncStream.makeStream(of: ServerConfigEvent.self, bufferingPolicy: .bufferingNewest(8))
    configUpdates = updates
    watcher = Task {
      defer { continuation.finish() }
      do {
        while let event = try await session.nextConfigEvent() { continuation.yield(event) }
        return "The server ended the session."
      } catch {
        return String(describing: error)
      }
    }
  }

  var initialConfig: ServerConfig { session.initialConfig }

  func probe() async throws {
    _ = try await session.probe()
  }

  func ended() async -> String {
    await watcher.value
  }

  func subscribeShell(_ subscription: ShellSubscription) async throws -> RpcStream<ShellStreamItem> {
    try await session.subscribeShell(subscription)
  }

  func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem> {
    try await session.rpc.stream(ThreadSubscription.rpcTag, payload: subscription, of: ThreadStreamItem.self)
  }

  func loadShellSnapshot(_ subscription: ShellSubscription) async throws -> ShellHTTPSnapshot {
    try await connector.shellSnapshot(subscription, endpoint: route.endpoint, vault: vault)
  }

  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as type: Response.Type
  ) async throws -> Response {
    try await session.rpc.call(tag, payload: payload, as: type)
  }

  func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of type: Item.Type
  ) async throws -> RpcStream<Item> {
    try await session.rpc.stream(tag, payload: payload, of: type)
  }

  func grantedScopes() async throws -> Set<String>? {
    try await connector.sessionState(endpoint: route.endpoint, vault: vault).grantedScopes
  }

  func close() async {
    await session.close()
  }
}
