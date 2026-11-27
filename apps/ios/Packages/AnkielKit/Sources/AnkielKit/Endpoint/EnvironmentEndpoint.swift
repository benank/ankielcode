import Foundation

/// One route to an environment: an `http(s)` base and its `ws(s)` twin. The base path is `/`, or
/// the `/h/<hostId>/` prefix of a path relay, which every server path keeps.
public struct EnvironmentEndpoint: Sendable, Hashable, Codable {
  public let httpBaseURL: URL
  public let wsBaseURL: URL

  /// Normalizes any `http`, `https`, `ws` or `wss` URL to its base: scheme, host and port, the relay
  /// prefix if present, and no query or fragment.
  public init?(_ components: URLComponents) {
    guard let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
      !host.isEmpty
    else { return nil }
    let secure: Bool
    switch scheme {
    case "http", "ws": secure = false
    case "https", "wss": secure = true
    default: return nil
    }
    var base = URLComponents()
    base.host = host
    base.port = components.port.flatMap { $0 == (secure ? 443 : 80) ? nil : $0 }
    base.path = Self.relayBasePath(components.path)
    base.scheme = secure ? "https" : "http"
    guard let http = base.url else { return nil }
    base.scheme = secure ? "wss" : "ws"
    guard let ws = base.url else { return nil }
    httpBaseURL = http
    wsBaseURL = ws
  }

  public init?(httpBaseURL: URL) {
    guard let components = URLComponents(url: httpBaseURL, resolvingAgainstBaseURL: false) else {
      return nil
    }
    self.init(components)
  }

  /// `/h/<26 base32 chars>/` (lowercased) for a path relay, else `/`.
  public static func relayBasePath(_ path: String) -> String {
    guard let match = path.prefixMatch(of: /\/h\/([a-zA-Z2-7]{26})(?:\/|$)/) else { return "/" }
    return "/h/\(match.1.lowercased())/"
  }

  public var relayHostId: String? {
    let path = httpBaseURL.path(percentEncoded: true)
    guard path.hasPrefix("/h/") else { return nil }
    return path.split(separator: "/").dropFirst().first.map(String.init)
  }

  /// A server path such as `/oauth/token` under this base, keeping the relay prefix.
  public func httpURL(_ path: String) -> URL {
    Self.join(httpBaseURL, path)
  }

  public func socketURL(_ path: String = "/ws") -> URL {
    Self.join(wsBaseURL, path)
  }

  /// Resolves a server-relative URL (`/api/assets/…`) the way `resolveAssetUrl` does: a single
  /// leading slash gets the relay prefix; absolute URLs pass through.
  public func resolve(relativeURL: String) -> URL? {
    if relativeURL.hasPrefix("/") && !relativeURL.hasPrefix("//") {
      return URL(string: httpBaseURL.absoluteString + relativeURL.dropFirst())
    }
    return URL(string: relativeURL, relativeTo: httpBaseURL)?.absoluteURL
  }

  /// `scheme://host[:port]` for display.
  public var origin: String {
    var components = URLComponents(url: httpBaseURL, resolvingAgainstBaseURL: false) ?? URLComponents()
    components.path = ""
    return components.string ?? httpBaseURL.absoluteString
  }

  /// True for loopback and private LAN addresses, which get the short descriptor timeout.
  public var isLocalNetwork: Bool {
    guard let host = httpBaseURL.host() else { return false }
    if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return true }
    let octets = host.split(separator: ".").compactMap { Int($0) }
    guard octets.count == 4 else { return false }
    switch (octets[0], octets[1]) {
    case (127, _), (10, _), (192, 168), (169, 254): return true
    case (172, 16...31): return true
    case (100, 64...127): return true  // CGNAT / Tailscale
    default: return false
    }
  }

  static func hostAndPort(_ components: URLComponents) -> String {
    [components.host, components.port.map(String.init)].compactMap(\.self).joined(separator: ":")
  }

  private static func join(_ base: URL, _ path: String) -> URL {
    let suffix = path.hasPrefix("/") ? String(path.dropFirst()) : path
    return URL(string: base.absoluteString + suffix) ?? base
  }
}
