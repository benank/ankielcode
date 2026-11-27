import Foundation

/// Why an address typed by hand was not added.
public enum AddRouteError: Error, Sendable, Hashable {
  case invalid
  /// Loopback reaches this phone, not the computer.
  case loopback
  case duplicate
  /// Plain `http` to a public address would send the sign-in in clear text.
  case cleartext
  /// Something else answers there.
  case mismatch
  case unreachable(String)
}

extension EnvironmentRegistry {
  /// Adds an address typed by hand. It must answer as this computer (its public descriptor, before
  /// any credential is sent) and keep the sign-in off clear text; it then reuses the computer's
  /// sign-in like a reported address, and the supervisor moves to it if the user prefers it.
  public func addRoute(_ input: String, to id: String) async throws(AddRouteError) -> EnvironmentRoute {
    guard let model = environment(id) else { throw .invalid }
    let endpoint: EnvironmentEndpoint
    do {
      endpoint = try PairingInput.resolve(host: input, code: "-").endpoint
    } catch {
      throw .invalid
    }
    if RouteSelection.isLoopback(endpoint) { throw .loopback }
    if model.record.routes.contains(where: { $0.endpoint == endpoint }) { throw .duplicate }
    guard RouteSelection.allowsCredential(endpoint, routes: model.record.routes) else { throw .cleartext }
    do {
      _ = try await connector.checkRoute(endpoint, environmentId: id)
    } catch {
      if case .environmentMismatch = error { throw .mismatch }
      throw .unreachable(EnvironmentConnector.describe(error))
    }
    guard let model = environment(id), !model.record.routes.contains(where: { $0.endpoint == endpoint }) else { throw .duplicate }
    let route = EnvironmentRoute(endpoint: endpoint, manual: true)
    model.record.routes.append(route)
    routesChanged(model)
    return route
  }

  /// Removes an address the user added (`RouteSelection.canRemove`).
  public func removeRoute(_ routeId: String, from id: String) {
    guard let model = environment(id), let route = model.record.routes.first(where: { $0.id == routeId }),
      RouteSelection.canRemove(route)
    else { return }
    model.record.routes.removeAll { $0.id == routeId }
    model.record.routeOrder?.removeAll { $0 == routeId }
    if model.record.lastRouteId == routeId { model.record.lastRouteId = nil }
    routesChanged(model)
  }

  /// The user's preferred order, best first.
  public func setRouteOrder(_ routeIds: [String], for id: String) {
    guard let model = environment(id) else { return }
    model.record.routeOrder = routeIds
    routesChanged(model)
  }

  /// The routes in preference order, as the computer page lists them.
  public func preferredRoutes(_ id: String) -> [EnvironmentRoute] {
    guard let model = environment(id) else { return [] }
    return RouteSelection.preference(model.record.routes, order: model.record.routeOrder)
  }

  private func routesChanged(_ model: EnvironmentModel) {
    persist()
    guard let runtime = model.runtime else { return }
    runtime.routes.routes = model.record.routes
    runtime.routes.order = model.record.routeOrder
    if runtime.routes.lastUsed.map({ last in !model.record.routes.contains { $0.id == last } }) == true {
      runtime.routes.lastUsed = nil
    }
    let supervisor = runtime.supervisor
    Task { await supervisor.recheckRoutes() }
  }

  /// `server.getRelayStatus` (needs `access:read`). Read only: changing the relay changes the
  /// computer's configuration for every device.
  public func relayStatus(_ id: String) async throws(EnvironmentRequestError) -> RelayStatus {
    try await request(id) { session in
      try await session.call(RelayStatus.rpcTag, payload: EmptyObject(), as: RelayStatus.self)
    }
  }
}

/// `RelayTunnelStatus`: the computer's Cloudflare Relay tunnel.
public struct RelayStatus: Sendable, Hashable, Decodable {
  public static let rpcTag = "server.getRelayStatus"
  public var configured: Bool
  public var connected: Bool
  public var relayOrigin: String?
  public var publicBaseUrl: String?
  /// `env` when set by environment variables on the computer, else `settings`.
  public var source: String?
  public var lastError: String?

  public init(configured: Bool, connected: Bool, relayOrigin: String? = nil, publicBaseUrl: String? = nil, source: String? = nil, lastError: String? = nil) {
    self.configured = configured
    self.connected = connected
    self.relayOrigin = relayOrigin
    self.publicBaseUrl = publicBaseUrl
    self.source = source
    self.lastError = lastError
  }

  enum CodingKeys: String, CodingKey { case configured, connected, relayOrigin, publicBaseUrl, source, lastError }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    configured = c.loose(Bool.self, .configured) ?? false
    connected = c.loose(Bool.self, .connected) ?? false
    relayOrigin = c.loose(String.self, .relayOrigin)
    publicBaseUrl = c.loose(String.self, .publicBaseUrl)
    source = c.loose(String.self, .source)
    lastError = c.loose(String.self, .lastError)
  }
}
