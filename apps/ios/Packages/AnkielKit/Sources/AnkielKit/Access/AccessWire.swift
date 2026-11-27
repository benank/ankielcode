import Foundation

// Sharing & access (`packages/contracts/src/auth.ts`): the computer's pairing links and the
// devices signed in to it, from `subscribeAuthAccess`, and the HTTP routes that change them.

/// The scopes a link or session holds: `permissions` when the server sends it, else the legacy
/// `scopes` subset (`authScopeResponse`).
private func grantedScopes(_ c: KeyedDecodingContainer<AccessScopeKeys>) -> [String] {
  if let permissions = c.loose(LossyArray<String>.self, .permissions)?.elements { return permissions }
  return c.loose(LossyArray<String>.self, .scopes)?.elements ?? []
}

private enum AccessScopeKeys: String, CodingKey { case scopes, permissions }

/// `AuthPairingLink`: a one-time link that has not been used yet. Its code is shown only to the
/// device that created it, in the create response.
public struct AccessPairingLink: Sendable, Hashable, Identifiable, Decodable {
  public var id: String
  public var label: String?
  public var scopes: [String]
  public var createdAt: WireTimestamp
  public var expiresAt: WireTimestamp

  public init(id: String, label: String? = nil, scopes: [String], createdAt: WireTimestamp, expiresAt: WireTimestamp) {
    self.id = id
    self.label = label
    self.scopes = scopes
    self.createdAt = createdAt
    self.expiresAt = expiresAt
  }

  enum CodingKeys: String, CodingKey { case id, label, createdAt, expiresAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    label = c.loose(String.self, .label)
    createdAt = try c.decode(WireTimestamp.self, forKey: .createdAt)
    expiresAt = try c.decode(WireTimestamp.self, forKey: .expiresAt)
    scopes = grantedScopes(try decoder.container(keyedBy: AccessScopeKeys.self))
  }
}

/// `AuthClientMetadata`: what the device said about itself when it paired.
public struct AccessClientMetadata: Sendable, Hashable, Decodable {
  public var label: String?
  public var ipAddress: String?
  public var deviceType: String
  public var os: String?
  public var browser: String?

  public init(label: String? = nil, ipAddress: String? = nil, deviceType: String = "unknown", os: String? = nil, browser: String? = nil) {
    self.label = label
    self.ipAddress = ipAddress
    self.deviceType = deviceType
    self.os = os
    self.browser = browser
  }

  enum CodingKeys: String, CodingKey { case label, ipAddress, deviceType, os, browser }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    label = c.loose(String.self, .label)
    ipAddress = c.loose(String.self, .ipAddress)
    deviceType = c.loose(String.self, .deviceType) ?? "unknown"
    os = c.loose(String.self, .os)
    browser = c.loose(String.self, .browser)
  }
}

/// `AuthClientSession`: one signed-in device. `current` is the session asking.
public struct AccessClientSession: Sendable, Hashable, Identifiable, Decodable {
  public var id: String { sessionId }
  public var sessionId: String
  public var subject: String
  public var scopes: [String]
  public var method: String
  public var client: AccessClientMetadata
  public var issuedAt: WireTimestamp
  public var expiresAt: WireTimestamp
  public var lastConnectedAt: WireTimestamp?
  public var connected: Bool
  public var current: Bool

  public init(
    sessionId: String, subject: String = "client", scopes: [String], method: String = "dpop-access-token",
    client: AccessClientMetadata, issuedAt: WireTimestamp, expiresAt: WireTimestamp, lastConnectedAt: WireTimestamp?,
    connected: Bool, current: Bool
  ) {
    self.sessionId = sessionId
    self.subject = subject
    self.scopes = scopes
    self.method = method
    self.client = client
    self.issuedAt = issuedAt
    self.expiresAt = expiresAt
    self.lastConnectedAt = lastConnectedAt
    self.connected = connected
    self.current = current
  }

  enum CodingKeys: String, CodingKey {
    case sessionId, subject, method, client, issuedAt, expiresAt, lastConnectedAt, connected, current
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = try c.decode(String.self, forKey: .sessionId)
    subject = c.loose(String.self, .subject) ?? ""
    method = c.loose(String.self, .method) ?? ""
    client = c.loose(AccessClientMetadata.self, .client) ?? AccessClientMetadata()
    issuedAt = try c.decode(WireTimestamp.self, forKey: .issuedAt)
    expiresAt = try c.decode(WireTimestamp.self, forKey: .expiresAt)
    lastConnectedAt = c.loose(WireTimestamp.self, .lastConnectedAt)
    connected = c.loose(Bool.self, .connected) ?? false
    current = c.loose(Bool.self, .current) ?? false
    scopes = grantedScopes(try decoder.container(keyedBy: AccessScopeKeys.self))
  }

  /// The row's name: the device's label, else its OS and browser, else the subject (web
  /// `ConnectedClientListRow`).
  public var displayName: String {
    if let label = client.label { return label }
    let parts = [client.os, client.browser].compactMap(\.self)
    return parts.isEmpty ? subject : parts.joined(separator: " · ")
  }

  /// Live now: this device, or another one with an open socket.
  public var isLive: Bool { current || connected }
}

/// `AuthAccessSnapshot`.
public struct AccessSnapshot: Sendable, Hashable, Decodable {
  public var pairingLinks: [AccessPairingLink]
  public var clientSessions: [AccessClientSession]

  public init(pairingLinks: [AccessPairingLink] = [], clientSessions: [AccessClientSession] = []) {
    self.pairingLinks = pairingLinks
    self.clientSessions = clientSessions
  }

  enum CodingKeys: String, CodingKey { case pairingLinks, clientSessions }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    pairingLinks = c.loose(LossyArray<AccessPairingLink>.self, .pairingLinks)?.elements ?? []
    clientSessions = c.loose(LossyArray<AccessClientSession>.self, .clientSessions)?.elements ?? []
  }

  /// Links that have not expired at `now`, newest first.
  public func openLinks(at now: Date) -> [AccessPairingLink] {
    pairingLinks.filter { ($0.expiresAt.date ?? .distantFuture) > now }.sorted { $0.createdAt > $1.createdAt }
  }

  /// Sessions for display: this device first, then live ones, then the most recently seen.
  public var sortedSessions: [AccessClientSession] {
    clientSessions.sorted { a, b in
      if a.current != b.current { return a.current }
      if a.isLive != b.isLive { return a.isLive }
      let left = a.lastConnectedAt ?? a.issuedAt
      let right = b.lastConnectedAt ?? b.issuedAt
      if left != right { return left > right }
      return a.sessionId < b.sessionId
    }
  }

  /// Another device is signed in (web `canRevokeOtherClients`).
  public var hasOtherSessions: Bool { clientSessions.contains { !$0.current } }
}

/// `AuthAccessStreamEvent`. Unknown event types are kept as `unknown` and change nothing.
public enum AccessStreamEvent: Sendable, Hashable, Decodable {
  case snapshot(AccessSnapshot)
  case pairingLinkUpserted(AccessPairingLink)
  case pairingLinkRemoved(id: String)
  case clientUpserted(AccessClientSession)
  case clientRemoved(sessionId: String)
  case unknown(String)

  enum CodingKeys: String, CodingKey { case type, payload }
  enum RemovedKeys: String, CodingKey { case id, sessionId }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "snapshot": self = .snapshot(try c.decode(AccessSnapshot.self, forKey: .payload))
    case "pairingLinkUpserted": self = .pairingLinkUpserted(try c.decode(AccessPairingLink.self, forKey: .payload))
    case "pairingLinkRemoved":
      self = .pairingLinkRemoved(id: try c.nestedContainer(keyedBy: RemovedKeys.self, forKey: .payload).decode(String.self, forKey: .id))
    case "clientUpserted": self = .clientUpserted(try c.decode(AccessClientSession.self, forKey: .payload))
    case "clientRemoved":
      self = .clientRemoved(
        sessionId: try c.nestedContainer(keyedBy: RemovedKeys.self, forKey: .payload).decode(String.self, forKey: .sessionId))
    default: self = .unknown(type)
    }
  }

  /// `applyAuthAccessStreamEvent`.
  public func applied(to snapshot: AccessSnapshot) -> AccessSnapshot {
    var next = snapshot
    switch self {
    case .snapshot(let all): return all
    case .pairingLinkUpserted(let link):
      next.pairingLinks.removeAll { $0.id == link.id }
      next.pairingLinks.append(link)
    case .pairingLinkRemoved(let id): next.pairingLinks.removeAll { $0.id == id }
    case .clientUpserted(let session):
      next.clientSessions.removeAll { $0.sessionId == session.sessionId }
      next.clientSessions.append(session)
    case .clientRemoved(let id): next.clientSessions.removeAll { $0.sessionId == id }
    case .unknown: break
    }
    return next
  }
}

// MARK: - Requests

/// `POST /api/auth/pairing-token` (`AuthCreatePairingCredentialInput`). Needs `access:write`, and
/// the server refuses scopes the caller does not hold itself.
public struct CreatePairingLinkRequest: Sendable, Hashable, Encodable {
  public static let path = "/api/auth/pairing-token"
  public var label: String?
  public var scopes: [String]

  public init(label: String?, scopes: [String]) {
    let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.label = trimmed?.isEmpty == false ? trimmed : nil
    self.scopes = scopes
  }
}

/// `AuthPairingCredentialResult`: the new link's id and its one-time code.
public struct PairingCredential: Sendable, Hashable, Decodable {
  public var id: String
  public var credential: String
  public var label: String?
  public var expiresAt: WireTimestamp

  public init(id: String, credential: String, label: String? = nil, expiresAt: WireTimestamp) {
    self.id = id
    self.credential = credential
    self.label = label
    self.expiresAt = expiresAt
  }
}

/// `POST /api/auth/pairing-links/revoke`.
public struct RevokePairingLinkRequest: Sendable, Hashable, Encodable {
  public static let path = "/api/auth/pairing-links/revoke"
  public var id: String
  public init(id: String) { self.id = id }
}

/// `POST /api/auth/clients/revoke`. The server refuses the caller's own session (403
/// `current_session_revoke_not_allowed`).
public struct RevokeClientRequest: Sendable, Hashable, Encodable {
  public static let path = "/api/auth/clients/revoke"
  public var sessionId: String
  public init(sessionId: String) { self.sessionId = sessionId }
}

/// `{revoked}`.
public struct RevokeResult: Sendable, Hashable, Decodable {
  public var revoked: Bool
}

public enum AccessRpc {
  public static let subscribe = "subscribeAuthAccess"
}

// MARK: - Pairing links to share

/// Builds what another device scans or opens (web `resolveDesktopPairingUrl`, `buildPairingAppLink`).
public enum PairingShare {
  /// `<base>/pair#token=<code>`, keeping a relay's `/h/<hostId>/` prefix.
  public static func pairingURL(endpoint: EnvironmentEndpoint, code: String) -> URL? {
    var components = URLComponents(url: endpoint.httpURL("/pair"), resolvingAgainstBaseURL: false)
    components?.fragment = "token=\(code)"
    return components?.url
  }

  /// `ankielcode://pair?pairingUrl=<url>`: the QR payload. Every Ankiel Code app (any
  /// `ankielcode[-channel]` scheme, and the camera) opens it.
  public static func appLink(_ pairingURL: URL) -> URL? {
    var components = URLComponents()
    components.scheme = "ankielcode"
    components.host = "pair"
    components.queryItems = [URLQueryItem(name: "pairingUrl", value: pairingURL.absoluteString)]
    // `URLQueryItem` leaves `#`, `&` and `=` inside values partly unescaped; encode them fully.
    components.percentEncodedQuery = "pairingUrl=" + (pairingURL.absoluteString.addingPercentEncoding(withAllowedCharacters: Self.queryValue) ?? "")
    return components.url
  }

  /// The routes another device could reach: never loopback, which would make the other device
  /// dial itself (web `isQrShareableEndpoint`). Relay and tailnet first, they work off the LAN.
  public static func shareableRoutes(_ routes: [EnvironmentRoute]) -> [EnvironmentRoute] {
    func rank(_ kind: ConnectionRouteKind) -> Int {
      switch kind {
      case .relay: 0
      case .tailnet: 1
      case .direct: 2
      case .lan: 3
      }
    }
    return routes.filter { !RouteSelection.isLoopback($0.endpoint) }
      .enumerated().sorted { (rank($0.element.kind), $0.offset) < (rank($1.element.kind), $1.offset) }.map(\.element)
  }

  private static let queryValue: CharacterSet = {
    var set = CharacterSet.alphanumerics
    set.insert(charactersIn: "-._~")
    return set
  }()
}

/// What a pairing link may grant (web `AUTH_SCOPE_OPTIONS` presets).
public enum PairingScopes {
  /// `AuthStandardClientScopes`: everything.
  public static let standard = AuthScope.grants
  /// The web dialog's "Read only" preset.
  public static let readOnly = ["orchestration:read", "filesystem:read", "diagnostics:read", "terminal:read"]

  /// A choice limited to what this device may hand on, in the server's order.
  public static func delegatable(_ choice: Set<String>, holding held: Set<String>) -> [String] {
    AuthScope.grants.filter { choice.contains($0) && held.contains($0) }
  }
}
