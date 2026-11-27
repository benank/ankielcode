import Foundation

/// The device's push choice (RN `pushNotificationsEnabled` + `pushNotificationKinds`). `unset`
/// was never turned on, so it asks nothing of any computer.
public struct PushPreference: Sendable, Hashable, Codable {
  public var enabled: Bool?
  /// nil means every kind.
  public var kinds: [PushAlertKind]?
  /// The one-time offer after the first new thread was shown (or push was set some other way).
  public var offered = false

  public init(enabled: Bool? = nil, kinds: [PushAlertKind]? = nil, offered: Bool = false) {
    self.enabled = enabled
    self.kinds = kinds
    self.offered = offered
  }

  /// The chosen kinds in their fixed order.
  public var effectiveKinds: [PushAlertKind] {
    guard let kinds else { return PushAlertKind.allCases }
    return PushAlertKind.allCases.filter(kinds.contains)
  }

  public func setting(_ kind: PushAlertKind, _ on: Bool) -> PushPreference {
    var next = self
    let current = effectiveKinds
    next.kinds = PushAlertKind.allCases.filter { $0 == kind ? on : current.contains($0) }
    return next
  }

  enum CodingKeys: String, CodingKey { case enabled, kinds, offered }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = c.loose(Bool.self, .enabled)
    kinds = c.loose([WireEnum<PushAlertKind>].self, .kinds)?.compactMap(\.known)
    offered = c.loose(Bool.self, .offered) ?? false
  }
}

/// The APNs token and where it is valid.
public struct PushDevice: Sendable, Hashable {
  public var token: String
  public var appId: String
  public var apnsEnvironment: ApnsEnvironment

  public init(token: String, appId: String, apnsEnvironment: ApnsEnvironment) {
    self.token = token
    self.appId = appId
    self.apnsEnvironment = apnsEnvironment
  }

  /// The token as APNs and the server's pattern want it.
  public static func hex(_ token: Data) -> String {
    token.map { String(format: "%02x", $0) }.joined()
  }
}

/// What the preference asks of every connected computer: a registration, or `nil` to unregister.
/// `key` names it, so an unrelated change never re-sends.
public struct PushTarget: Sendable, Hashable {
  public var key: String
  public var registration: PushRegistration?

  /// nil while there is nothing to send: never turned on, or on but the token is still being read.
  public static func make(_ preference: PushPreference, device: PushDevice?, locale: String) -> PushTarget? {
    guard let enabled = preference.enabled else { return nil }
    guard enabled else { return PushTarget(key: "off", registration: nil) }
    guard let device else { return nil }
    let registration = PushRegistration(
      token: device.token, appId: device.appId, apnsEnvironment: device.apnsEnvironment,
      kinds: preference.effectiveKinds, locale: locale)
    let key = [
      device.token, device.apnsEnvironment.rawValue, registration.kinds.map(\.rawValue).joined(separator: ","), registration.locale,
    ].joined(separator: "|")
    return PushTarget(key: key, registration: registration)
  }
}

/// Per-computer bookkeeping, one connection each (RN `PushSyncState`): a computer is synced once
/// per connection and target, and forgotten when it disconnects so a reconnect registers again.
/// A failed attempt counts as applied, so an older server without the RPC is not retried on every
/// unrelated change; the next connection or target tries again.
public struct PushSyncState: Sendable {
  private var applied: [String: String] = [:]
  private var inFlight: Set<String> = []
  /// In flight when their connection dropped, so the answer belongs to the old connection.
  private var stale: Set<String> = []

  public init() {}

  /// The computers to send `target` to now; marks them in flight.
  public mutating func take(connected: Set<String>, target: PushTarget?) -> [String] {
    for id in applied.keys where !connected.contains(id) { applied[id] = nil }
    for id in inFlight where !connected.contains(id) { stale.insert(id) }
    guard let target else { return [] }
    let due = connected.sorted().filter { !inFlight.contains($0) && applied[$0] != target.key }
    inFlight.formUnion(due)
    return due
  }

  public mutating func settle(_ environmentId: String, key: String) {
    inFlight.remove(environmentId)
    if stale.remove(environmentId) == nil { applied[environmentId] = key }
  }

  /// The target last applied on this connection.
  public func appliedKey(_ environmentId: String) -> String? { applied[environmentId] }
}

/// One computer's line on the Notifications page (RN `pushStatusLabel`), most blocking first.
public enum PushComputerState: Sendable, Hashable {
  case notConnected
  case checking
  case relayNotSetUp
  case relayOffline
  case noPushKey
  case notRegisteredYet
  case on
  /// The server refused the status read (an older server without push, for one).
  case failed(String?)

  public static func derive(connected: Bool, status: PushStatus?, error: EnvironmentRequestError?) -> Self {
    guard connected else { return .notConnected }
    if let error {
      switch error {
      case .notConnected: return .notConnected
      case .rejected(let message, _): return .failed(message)
      case .failed(let message): return .failed(message)
      }
    }
    guard let status else { return .checking }
    if !status.relayConfigured { return .relayNotSetUp }
    if !status.relayConnected { return .relayOffline }
    if !status.availableOnIOS { return .noPushKey }
    return status.registeredKinds == nil ? .notRegisteredYet : .on
  }
}

/// Reads `aps-environment` from a provisioning profile (`embedded.mobileprovision`, a CMS blob
/// with the plist inside). nil without a profile, which is the simulator.
public enum ProvisioningProfile {
  public static func apnsEnvironment(_ profile: Data?) -> ApnsEnvironment? {
    guard let profile,
      let start = profile.range(of: Data("<?xml".utf8)),
      let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
      let plist = try? PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound], format: nil)
        as? [String: Any],
      let entitlements = plist["Entitlements"] as? [String: Any],
      let value = entitlements["aps-environment"] as? String
    else { return nil }
    return value == "development" ? .sandbox : .production
  }

  /// Without a profile: the simulator talks to the sandbox, and an App Store or TestFlight
  /// install (whose profile is stripped) to production.
  public static func resolve(_ profile: Data?, isSimulator: Bool) -> ApnsEnvironment {
    apnsEnvironment(profile) ?? (isSimulator ? .sandbox : .production)
  }
}
