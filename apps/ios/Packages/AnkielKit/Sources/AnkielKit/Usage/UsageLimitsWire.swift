import Foundation

/// `ServerProviderUsageLimits` (spec A.2): a provider account's subscription windows as its
/// computer last read them. Decodes loosely; an unreadable window is dropped, not the provider.
public struct ProviderUsageLimits: Sendable, Hashable, Codable {
  public var checkedAt: Date
  public var windows: [UsageWindow]
  public var zeroSpendCap: Bool?
  public var credentialFingerprint: String?
  public var resetCredits: ResetCredits?
  public var externalUsage: ExternalUsage?
  public var unavailable: Unavailable?

  public struct ExternalUsage: Sendable, Hashable, Codable {
    public var label: String
    public var url: String

    public init(label: String, url: String) {
      self.label = label
      self.url = url
    }
  }

  public struct Unavailable: Sendable, Hashable, Codable {
    /// `unsupported` or `probeFailed`.
    public var reason: String
    public var message: String?

    public init(reason: String, message: String? = nil) {
      self.reason = reason
      self.message = message
    }
  }

  public init(
    checkedAt: Date, windows: [UsageWindow], credentialFingerprint: String? = nil, resetCredits: ResetCredits? = nil,
    externalUsage: ExternalUsage? = nil, unavailable: Unavailable? = nil
  ) {
    self.checkedAt = checkedAt
    self.windows = windows
    self.credentialFingerprint = credentialFingerprint
    self.resetCredits = resetCredits
    self.externalUsage = externalUsage
    self.unavailable = unavailable
  }

  enum CodingKeys: String, CodingKey {
    case checkedAt, windows, zeroSpendCap, credentialFingerprint, resetCredits, externalUsage, unavailable
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    checkedAt = try c.decode(WireTimestamp.self, forKey: .checkedAt).date ?? .distantPast
    windows = c.loose(LossyArray<UsageWindow>.self, .windows)?.elements ?? []
    zeroSpendCap = c.loose(Bool.self, .zeroSpendCap)
    credentialFingerprint = c.loose(String.self, .credentialFingerprint)
    resetCredits = c.loose(ResetCredits.self, .resetCredits)
    externalUsage = c.loose(ExternalUsage.self, .externalUsage)
    unavailable = c.loose(Unavailable.self, .unavailable)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(WireTimestamp(checkedAt), forKey: .checkedAt)
    try c.encode(windows, forKey: .windows)
    try c.encodeIfPresent(zeroSpendCap, forKey: .zeroSpendCap)
    try c.encodeIfPresent(credentialFingerprint, forKey: .credentialFingerprint)
    try c.encodeIfPresent(resetCredits, forKey: .resetCredits)
    try c.encodeIfPresent(externalUsage, forKey: .externalUsage)
    try c.encodeIfPresent(unavailable, forKey: .unavailable)
  }
}

/// `ServerProviderUsageWindow`: one allowance (a 5-hour session, a week, a month, a model pool).
public struct UsageWindow: Sendable, Hashable, Codable, Identifiable {
  public enum Kind: String, Sendable, Codable, CaseIterable {
    case session, weekly, monthly, other

    /// RN `WINDOW_KIND_ORDER`.
    public var order: Int {
      switch self {
      case .session: 0
      case .weekly: 1
      case .monthly: 2
      case .other: 3
      }
    }
  }

  public var id: String
  public var kind: Kind
  public var label: String
  public var modelIds: [String]?
  public var providerIds: [String]?
  public var usedPercent: Double
  public var resetsAt: Date?
  public var windowDurationMins: Int?

  public init(
    id: String, kind: Kind, label: String, usedPercent: Double, resetsAt: Date? = nil, windowDurationMins: Int? = nil
  ) {
    self.id = id
    self.kind = kind
    self.label = label
    self.usedPercent = usedPercent
    self.resetsAt = resetsAt
    self.windowDurationMins = windowDurationMins
  }

  enum CodingKeys: String, CodingKey {
    case id, kind, label, modelIds, providerIds, usedPercent, resetsAt, windowDurationMins
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    // A kind from a newer server pools and sorts with "other".
    kind = c.loose(String.self, .kind).flatMap(Kind.init(rawValue:)) ?? .other
    label = c.loose(String.self, .label) ?? id
    modelIds = c.loose([String].self, .modelIds)
    providerIds = c.loose([String].self, .providerIds)
    let used = try c.decode(WireNumber.self, forKey: .usedPercent).value
    usedPercent = used.isFinite ? used : 0
    resetsAt = c.loose(WireTimestamp.self, .resetsAt)?.date
    windowDurationMins = c.loose(Int.self, .windowDurationMins)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(kind, forKey: .kind)
    try c.encode(label, forKey: .label)
    try c.encodeIfPresent(modelIds, forKey: .modelIds)
    try c.encodeIfPresent(providerIds, forKey: .providerIds)
    try c.encode(usedPercent, forKey: .usedPercent)
    try c.encodeIfPresent(resetsAt.map(WireTimestamp.init), forKey: .resetsAt)
    try c.encodeIfPresent(windowDurationMins, forKey: .windowDurationMins)
  }
}

/// `ServerProviderResetCredits`: banked resets the account can redeem.
public struct ResetCredits: Sendable, Hashable, Codable {
  public var availableCount: Int
  public var nextExpiresAt: Date?

  public init(availableCount: Int, nextExpiresAt: Date? = nil) {
    self.availableCount = availableCount
    self.nextExpiresAt = nextExpiresAt
  }

  enum CodingKeys: String, CodingKey { case availableCount, nextExpiresAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    availableCount = max(0, c.loose(Int.self, .availableCount) ?? 0)
    nextExpiresAt = c.loose(WireTimestamp.self, .nextExpiresAt)?.date
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(availableCount, forKey: .availableCount)
    try c.encodeIfPresent(nextExpiresAt.map(WireTimestamp.init), forKey: .nextExpiresAt)
  }
}

/// `server.refreshProviders {}`: re-probes every provider on the computer (limits included). The
/// fresh list also arrives on the config stream as `providerStatuses`.
public struct RefreshProvidersRequest: Sendable, Hashable, Encodable {
  public init() {}
  public static let rpcTag = "server.refreshProviders"
}

/// `provider.consumeResetCredit {instanceId}` (`providers:manage`).
public struct ConsumeResetCreditRequest: Sendable, Hashable, Encodable {
  public var instanceId: String

  public init(instanceId: String) { self.instanceId = instanceId }
  public static let rpcTag = "provider.consumeResetCredit"
}

/// `ProviderConsumeResetCreditResult`.
public struct ConsumeResetCreditResult: Sendable, Hashable, Decodable {
  public enum Outcome: String, Sendable { case reset, nothingToReset, noCredit, alreadyRedeemed }
  public var outcome: WireEnum<Outcome>
  public var warning: String?
}
