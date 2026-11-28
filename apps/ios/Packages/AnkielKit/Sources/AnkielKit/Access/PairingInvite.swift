import Foundation

// Device pairing invites (`packages/contracts/src/environmentHttp.ts`, `packages/shared/src/remote.ts`):
// this device creates a one-time invite, another device claims it with its DPoP key, both show the
// same code, and this device approves or denies. Invites live in server memory for two minutes, at
// most 16 at once, and only the session that created one can read or decide it (404 otherwise).

public enum PairingInviteWire {
  public static let path = "/api/auth/pairing-invites"
  public static func path(_ inviteId: String) -> String { "\(path)/\(escaped(inviteId))" }
  public static func approvePath(_ inviteId: String) -> String { "\(path(inviteId))/approve" }
  public static func denyPath(_ inviteId: String) -> String { "\(path(inviteId))/deny" }
  public static func claimPath(_ inviteId: String) -> String { "\(path(inviteId))/claim" }

  /// `PAIRING_HANDOFF_ACTIVITY_TYPE`: the Handoff activity the desktop app continues.
  public static let activityType = "com.ankiel.ankielcode.pair-environment"
  /// `PAIRING_INVITE_UTTYPE`, its MIME type and file extension (without the dot).
  public static let fileType = "com.ankiel.ankielcode.pairing-invite"
  public static let mimeType = "application/vnd.ankielcode.pairing-invite+json"
  public static let fileExtension = "ankielpair"
  public static let maxFileBytes = 16_384

  private static func escaped(_ id: String) -> String {
    id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
  }
}

/// `AuthCreatePairingInviteInput`. RN sends only `scopes`, and only when this session holds less
/// than every standard scope.
public struct CreatePairingInviteRequest: Sendable, Hashable, Encodable {
  public var scopes: [String]?
  public init(scopes: [String]?) { self.scopes = scopes }
}

/// `AuthCreatePairingInviteResult`.
public struct PairingInviteCreated: Sendable, Hashable, Decodable {
  public var inviteId: String
  public var expiresAt: WireTimestamp
  public var scopes: [String]

  public init(inviteId: String, expiresAt: WireTimestamp, scopes: [String]) {
    self.inviteId = inviteId
    self.expiresAt = expiresAt
    self.scopes = scopes
  }
}

/// `AuthPairingInviteClaimMetadata`: who claimed the invite, and the code both screens show.
public struct PairingInviteClaim: Sendable, Hashable, Decodable {
  public var clientLabel: String?
  public var clientDeviceType: String
  public var clientOs: String
  public var verificationCode: String
  public var claimedAt: WireTimestamp?

  public init(clientLabel: String? = nil, clientDeviceType: String, clientOs: String, verificationCode: String, claimedAt: WireTimestamp? = nil) {
    self.clientLabel = clientLabel
    self.clientDeviceType = clientDeviceType
    self.clientOs = clientOs
    self.verificationCode = verificationCode
    self.claimedAt = claimedAt
  }

  enum CodingKeys: String, CodingKey { case clientLabel, clientDeviceType, clientOs, verificationCode, claimedAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    verificationCode = try c.decode(String.self, forKey: .verificationCode)
    clientLabel = c.loose(String.self, .clientLabel)
    clientDeviceType = c.loose(String.self, .clientDeviceType) ?? "unknown"
    clientOs = c.loose(String.self, .clientOs) ?? ""
    claimedAt = c.loose(WireTimestamp.self, .claimedAt)
  }
}

/// `AuthPairingInviteStatus`.
public struct PairingInviteStatus: Sendable, Hashable, Decodable {
  public enum Phase: String, Sendable, Hashable { case pending, claimed, approved, denied, cancelled, expired }

  public var inviteId: String
  public var expiresAt: WireTimestamp
  public var scopes: [String]
  public var status: WireEnum<Phase>
  public var claim: PairingInviteClaim?

  public init(inviteId: String, expiresAt: WireTimestamp, scopes: [String], status: Phase, claim: PairingInviteClaim? = nil) {
    self.inviteId = inviteId
    self.expiresAt = expiresAt
    self.scopes = scopes
    self.status = .known(status)
    self.claim = claim
  }

  enum CodingKeys: String, CodingKey { case inviteId, expiresAt, scopes, status, claim }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    inviteId = try c.decode(String.self, forKey: .inviteId)
    expiresAt = try c.decode(WireTimestamp.self, forKey: .expiresAt)
    scopes = c.loose(LossyArray<String>.self, .scopes)?.elements ?? []
    status = try c.decode(WireEnum<Phase>.self, forKey: .status)
    claim = c.loose(PairingInviteClaim.self, .claim)
  }
}

/// `AuthApprovePairingInviteInput`: the code this device showed, echoed back.
public struct ApprovePairingInviteRequest: Sendable, Hashable, Encodable {
  public var verificationCode: String
  public init(verificationCode: String) { self.verificationCode = verificationCode }
}

/// `AuthApprovePairingInviteResult`.
public struct PairingInviteApproved: Sendable, Hashable, Decodable {
  public var status: String
  public var grantExpiresAt: WireTimestamp

  public init(status: String, grantExpiresAt: WireTimestamp) {
    self.status = status
    self.grantExpiresAt = grantExpiresAt
  }
}

/// `AuthDenyPairingInviteResult`: `denied` once claimed, `cancelled` while still pending.
public struct PairingInviteDenied: Sendable, Hashable, Decodable {
  public var status: String
  public init(status: String) { self.status = status }
}

// MARK: - The claiming side (the probe; the app never claims)

/// `AuthClaimPairingInviteInput`, sent with a DPoP proof and no session.
public struct ClaimPairingInviteRequest: Sendable, Hashable, Encodable {
  public var clientLabel: String?
  public var clientDeviceType: String?
  public var clientOs: String?

  public init(clientLabel: String? = nil, clientDeviceType: String? = nil, clientOs: String? = nil) {
    self.clientLabel = clientLabel
    self.clientDeviceType = clientDeviceType
    self.clientOs = clientOs
  }
}

/// `AuthClaimPairingInviteResult`.
public struct PairingInviteClaimed: Sendable, Hashable, Decodable {
  public var status: String
  public var verificationCode: String
  public var expiresAt: WireTimestamp
}

/// `AuthPairingInviteClaimStatus`: `credential` arrives once, with `approved`; it is spent at
/// `/oauth/token` like a pairing code, with the key that claimed.
public struct PairingInviteClaimStatus: Sendable, Hashable, Decodable {
  public var status: String
  public var expiresAt: WireTimestamp?
  public var grantExpiresAt: WireTimestamp?
  public var credential: String?
}

// MARK: - Errors

/// A refused or failed invite call, keeping the server's `reason` (`EnvironmentRequestError`
/// drops it), which picks the message.
public enum PairingInviteError: Error, Sendable, Hashable {
  case notConnected
  case rejected(tag: String?, reason: String?, message: String?)
  case failed(String)

  public init(_ error: any Error) {
    switch error {
    case let error as PairingInviteError: self = error
    case RpcError.failed(let failure):
      self = .rejected(tag: failure.tag, reason: failure.error["reason"]?.stringValue, message: failure.message)
    case RpcError.connectionClosed: self = .notConnected
    default: self = .failed(String(describing: error))
    }
  }

  public var tag: String? { if case .rejected(let tag, _, _) = self { tag } else { nil } }
  public var reason: String? { if case .rejected(_, let reason, _) = self { reason } else { nil } }

  /// RN `classifyPairingPollError`: a 404 means the invite is gone (expired, or another
  /// session's), auth and permission refusals end the flow, anything else is retried.
  public enum PollOutcome: Sendable, Hashable { case expired, permanent, transient }

  public var pollOutcome: PollOutcome {
    switch tag {
    case "EnvironmentResourceNotFoundError": .expired
    case "EnvironmentAuthInvalidError", "EnvironmentScopeRequiredError", "EnvironmentOperationForbiddenError": .permanent
    default: .transient
    }
  }
}

// MARK: - What the other device receives

/// `PairingInvitePayload`: the invite as Handoff, the `.ankielpair` file and the
/// `ankielcode://pair-invite` link carry it. `validated()` is `readPairingInvite`.
public struct PairingInvitePayload: Sendable, Hashable {
  public var inviteId: String
  public var environmentId: String
  public var baseUrl: String
  public var label: String?
  public var expiresAt: String?

  public init(inviteId: String, environmentId: String, baseUrl: String, label: String? = nil, expiresAt: String? = nil) {
    self.inviteId = inviteId
    self.environmentId = environmentId
    self.baseUrl = baseUrl
    self.label = label
    self.expiresAt = expiresAt
  }

  /// The payload the receiving side would accept (base URL normalized), or nil.
  public func validated() -> PairingInvitePayload? {
    guard inviteId.wholeMatch(of: /[A-Za-z0-9_-]{1,128}/) != nil,
      !environmentId.isEmpty, environmentId.utf16.count <= 256, environmentId == Self.jsTrimmed(environmentId),
      !Self.hasControl(environmentId),
      baseUrl.utf16.count <= 1_024, baseUrl.prefixMatch(of: /(?i)https?:\/\/[^\/?#@\\\s]+(?:\/|$)/) != nil,
      baseUrl.firstMatch(of: /[?#\\\s]/) == nil, !Self.hasControl(baseUrl)
    else { return nil }
    if let label {
      guard !label.isEmpty, label == Self.jsTrimmed(label), !Self.hasControl(label), label.utf8.count <= 256 else { return nil }
    }
    if let expiresAt {
      guard expiresAt.wholeMatch(of: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})/) != nil,
        WireTimestamp(rawValue: expiresAt).date != nil
      else { return nil }
    }
    guard let components = URLComponents(string: baseUrl), components.user == nil, components.password == nil,
      let endpoint = EnvironmentEndpoint(components)
    else { return nil }
    let href = endpoint.httpBaseURL.absoluteString
    guard href.utf16.count <= 1_024 else { return nil }
    var next = self
    next.baseUrl = href
    return next
  }

  /// `toPairingInviteUserInfo`: Handoff's `userInfo`, every value a string.
  public var userInfo: [String: String] {
    Dictionary(uniqueKeysWithValues: fields.map { ($0.0 == "v" ? "version" : $0.0, $0.1) })
  }

  /// `encodePairingInviteFile`: the `.ankielpair` file's JSON, byte for byte.
  public var fileJSON: String {
    var parts = [#""version":1"#]
    for (key, value) in fields.dropFirst() { parts.append("\(Self.jsonString(key)):\(Self.jsonString(value))") }
    return "{\(parts.joined(separator: ","))}"
  }

  /// `buildPairingInviteAppLink`: always the `ankielcode` scheme, since the desktop app receives it.
  public func appLink(scheme: String = "ankielcode") -> String {
    "\(scheme)://pair-invite?" + fields.map { "\(Self.formEncode($0.0))=\(Self.formEncode($0.1))" }.joined(separator: "&")
  }

  /// The fields in `readPairingInvite`'s order, `v` first.
  private var fields: [(String, String)] {
    var fields = [("v", "1"), ("inviteId", inviteId), ("environmentId", environmentId), ("baseUrl", baseUrl)]
    if let label { fields.append(("label", label)) }
    if let expiresAt { fields.append(("expiresAt", expiresAt)) }
    return fields
  }

  /// `URLSearchParams` serialization (application/x-www-form-urlencoded).
  private static func formEncode(_ value: String) -> String {
    var out = ""
    for byte in value.utf8 {
      switch byte {
      case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
        UInt8(ascii: "*"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"):
        out.unicodeScalars.append(UnicodeScalar(byte))
      case UInt8(ascii: " "): out += "+"
      default: out += String(format: "%%%02X", byte)
      }
    }
    return out
  }

  /// `JSON.stringify` of one string.
  private static func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }

  private static func hasControl(_ value: String) -> Bool {
    value.unicodeScalars.contains { $0.properties.generalCategory == .control }
  }

  /// `String.prototype.trim`: JS whitespace and line terminators.
  private static func jsTrimmed(_ value: String) -> String {
    value.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
  }
}

// MARK: - Rules shared by the page and its tests

public enum PairingInviteRules {
  /// RN `resolveDefaultPairingScopes`: nil (the server's default, everything this session may
  /// hand on) when this session holds every standard scope or the server did not say; else the
  /// standard scopes it holds.
  public static func defaultScopes(held: Set<String>?) -> [String]? {
    guard let held else { return nil }
    let granted = AuthScope.grants.filter(held.contains)
    return granted.isEmpty || granted.count == AuthScope.grants.count ? nil : granted
  }

  /// RN `isFullStandardClientScopeSet`.
  public static func grantsEverything(_ scopes: [String]) -> Bool {
    Set(AuthScope.grants).isSubset(of: Set(scopes))
  }

  /// RN `selectShareablePairingBaseUrl`: a connected relay's https address first; then the saved
  /// routes with the active one first, the first https one winning, else the first http one; a
  /// configured but disconnected relay last. Never loopback, wildcard or `.localhost`, which would
  /// make the other device dial itself.
  public static func shareableBaseURL(relay: RelayStatus?, routes: [EnvironmentRoute], activeRoute: EnvironmentRoute?) -> String? {
    let relayURL = relay.flatMap { normalized($0.publicBaseUrl, requireHTTPS: true) }
    if relay?.connected == true, let relayURL { return relayURL }
    let disconnectedRelay = relay?.configured == true ? relayURL : nil
    let ordered: [EnvironmentRoute] =
      if let activeRoute { routes.filter { $0.id == activeRoute.id } + routes.filter { $0.id != activeRoute.id } } else { routes }
    var http: String?
    for route in ordered {
      guard let url = normalized(route.endpoint.httpBaseURL.absoluteString), url != disconnectedRelay else { continue }
      if url.hasPrefix("https://") { return url }
      if http == nil { http = url }
    }
    return http ?? disconnectedRelay
  }

  /// RN `normalizeShareablePairingUrl`.
  static func normalized(_ raw: String?, requireHTTPS: Bool = false) -> String? {
    let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty, let components = URLComponents(string: trimmed),
      let scheme = components.scheme?.lowercased(), scheme == "https" || (scheme == "http" && !requireHTTPS),
      components.user == nil, components.password == nil,
      let endpoint = EnvironmentEndpoint(components), isShareable(host: components.host ?? "")
    else { return nil }
    return endpoint.httpBaseURL.absoluteString
  }

  static func isShareable(host: String) -> Bool {
    var host = host.lowercased()
    if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    while host.hasSuffix(".") { host.removeLast() }
    if host.isEmpty || host == "localhost" || host == "::1" || host == "0.0.0.0" || host == "::" || host.hasSuffix(".localhost") {
      return false
    }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    let ipv4 = parts.count == 4 && parts.allSatisfy { ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }
    return !(ipv4 && parts[0] == 127)
  }

  /// RN `formatCountdown`: whole seconds rounded up, `m:ss`.
  public static func countdown(_ remaining: TimeInterval) -> String {
    let total = max(0, Int(remaining.rounded(.up)))
    return "\(total / 60):" + String(format: "%02d", total % 60)
  }

  /// What RN `formatClaimDeviceFallback` names a device that sent no label.
  public enum DeviceFallback: Sendable, Hashable {
    case desktop(os: String?), mobile(os: String?), tablet(os: String?), bot
    /// An unknown kind: its OS when known, else "Another device".
    case other(os: String?)
  }

  public static func deviceFallback(type: String, os: String) -> DeviceFallback {
    let trimmed = os.trimmingCharacters(in: .whitespacesAndNewlines)
    let known: String? = trimmed.isEmpty || trimmed.lowercased() == "unknown" ? nil : trimmed
    switch type {
    case "desktop": return .desktop(os: known)
    case "mobile": return .mobile(os: known)
    case "tablet": return .tablet(os: known)
    case "bot": return .bot
    default: return .other(os: known)
    }
  }
}
