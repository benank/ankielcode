import Foundation

/// How a route reaches its environment, for display and timeouts.
public enum ConnectionRouteKind: String, Sendable, Hashable, Codable {
  /// A Cloudflare Relay (path prefix `/h/<hostId>/` or a `<hostId>.` subdomain).
  case relay
  /// Loopback or a private LAN address.
  case lan
  /// Tailscale (CGNAT range or `*.ts.net`).
  case tailnet
  /// Anything else: a public host or reverse proxy.
  case direct

  /// Loopback and LAN answer within 3 s reliably; tailnets and relays can spike past it.
  public var answersQuickly: Bool { self == .lan }

  public init(endpoint: EnvironmentEndpoint) {
    let host = endpoint.httpBaseURL.host()?.lowercased() ?? ""
    if endpoint.relayHostId != nil
      || host.split(separator: ".").first.map({ $0.wholeMatch(of: /[a-z2-7]{26}/) != nil }) == true
    {
      self = .relay
    } else if host.hasSuffix(".ts.net") || Self.isCGNAT(host) {
      self = .tailnet
    } else if endpoint.isLocalNetwork {
      self = .lan
    } else {
      self = .direct
    }
  }

  private static func isCGNAT(_ host: String) -> Bool {
    let octets = host.split(separator: ".").compactMap { Int($0) }
    return octets.count == 4 && octets[0] == 100 && (64...127).contains(octets[1])
  }
}

/// One saved way to reach an environment. The paired route is `learned == false`; learned routes
/// come from the server's `directEndpoints` and reuse the paired credential.
public struct EnvironmentRoute: Sendable, Hashable, Codable {
  public var kind: ConnectionRouteKind
  public var endpoint: EnvironmentEndpoint
  public var learned: Bool

  public init(endpoint: EnvironmentEndpoint, kind: ConnectionRouteKind? = nil, learned: Bool = false) {
    self.endpoint = endpoint
    self.kind = kind ?? ConnectionRouteKind(endpoint: endpoint)
    self.learned = learned
  }

  public var id: String { endpoint.httpBaseURL.absoluteString }
}

/// Route rules from `packages/client-runtime/src/connection/routes.ts`.
public enum RouteSelection {
  /// Adds the server's reported endpoints as learned routes. Skips loopback and non-http(s)
  /// addresses, and never sends a token in clear text to a public address: a plain-`http` route
  /// that is not LAN or tailnet is only kept when the credential was itself paired over plain HTTP.
  public static func learn(
    _ reported: [ServerConfig.DirectEndpoint], into routes: [EnvironmentRoute]
  ) -> [EnvironmentRoute] {
    let pairedInClear = routes.contains { !$0.learned && $0.endpoint.httpBaseURL.scheme == "http" }
    var result = routes
    for endpoint in reported {
      guard let url = URL(string: endpoint.httpBaseUrl), let scheme = url.scheme?.lowercased(),
        scheme == "http" || scheme == "https", let base = EnvironmentEndpoint(httpBaseURL: url),
        !isLoopback(base)
      else { continue }
      let kind: ConnectionRouteKind =
        switch endpoint.kind {
        case .known(.lan): .lan
        case .known(.tailnet): .tailnet
        case .known(.relay): .relay
        default: ConnectionRouteKind(endpoint: base)
        }
      if scheme == "http", kind != .lan, kind != .tailnet, !pairedInClear { continue }
      guard !result.contains(where: { $0.endpoint == base }) else { continue }
      result.append(EnvironmentRoute(endpoint: base, kind: kind, learned: true))
    }
    return result
  }

  /// The order to try routes in one attempt: the route that last worked, then local routes (they
  /// answer or fail fast), then the paired route, then the rest.
  public static func order(_ routes: [EnvironmentRoute], lastUsed: String?) -> [EnvironmentRoute] {
    func rank(_ route: EnvironmentRoute) -> Int {
      if route.id == lastUsed { return 0 }
      if route.learned, route.kind == .lan { return 1 }
      if !route.learned { return 2 }
      return 3
    }
    return routes.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
      .map(\.element)
  }

  static func isLoopback(_ endpoint: EnvironmentEndpoint) -> Bool {
    let host = endpoint.httpBaseURL.host()?.lowercased() ?? ""
    return host == "localhost" || host == "::1" || host == "[::1]" || host.hasPrefix("127.")
  }
}
