import Foundation

/// What a computer can push about (`PushAlertKind`, `packages/contracts/src/push.ts`).
public enum PushAlertKind: String, Sendable, Hashable, Codable, CaseIterable {
  case completed, failed, approval, input
}

/// Which APNs gateway the token belongs to (`PushApnsEnvironment`).
public enum ApnsEnvironment: String, Sendable, Hashable, Codable {
  case sandbox, production
}

/// `server.registerPush` input for iOS (`PushRegisterInput`, the `ios` member). The server keeps
/// one registration per auth session, so registering again replaces it.
public struct PushRegistration: Sendable, Hashable, Encodable {
  public var platform = "ios"
  /// The APNs device token, lowercase hex.
  public var token: String
  /// The bundle id, which APNs takes as the topic.
  public var appId: String
  public var apnsEnvironment: ApnsEnvironment
  public var kinds: [PushAlertKind]
  /// At most 35 characters (the server's cap).
  public var locale: String

  public init(token: String, appId: String, apnsEnvironment: ApnsEnvironment, kinds: [PushAlertKind], locale: String) {
    self.token = token
    self.appId = appId
    self.apnsEnvironment = apnsEnvironment
    self.kinds = kinds
    self.locale = String(locale.prefix(Self.maxLocaleLength))
  }

  public static let maxLocaleLength = 35
  public static let registerTag = "server.registerPush"
  public static let unregisterTag = "server.unregisterPush"
  public static let statusTag = "server.getPushStatus"
}

/// `PushStatus`: the computer's relay and this session's registration.
public struct PushStatus: Sendable, Hashable, Decodable {
  public var relayConfigured: Bool
  public var relayConnected: Bool
  /// What the connected relay can deliver to; false while it is disconnected.
  public var availableOnIOS: Bool
  /// This session's registration, nil when it has none.
  public var registeredKinds: [WireEnum<PushAlertKind>]?

  public init(relayConfigured: Bool, relayConnected: Bool, availableOnIOS: Bool, registeredKinds: [WireEnum<PushAlertKind>]?) {
    self.relayConfigured = relayConfigured
    self.relayConnected = relayConnected
    self.availableOnIOS = availableOnIOS
    self.registeredKinds = registeredKinds
  }

  enum CodingKeys: String, CodingKey { case relayConfigured, relayConnected, available, registration }
  enum AvailableKeys: String, CodingKey { case ios }
  enum RegistrationKeys: String, CodingKey { case kinds }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    relayConfigured = c.loose(Bool.self, .relayConfigured) ?? false
    relayConnected = c.loose(Bool.self, .relayConnected) ?? false
    let available = try? c.nestedContainer(keyedBy: AvailableKeys.self, forKey: .available)
    availableOnIOS = available?.loose(Bool.self, .ios) ?? false
    if let registration = try? c.nestedContainer(keyedBy: RegistrationKeys.self, forKey: .registration) {
      registeredKinds = registration.loose([WireEnum<PushAlertKind>].self, .kinds) ?? []
    } else {
      registeredKinds = nil
    }
  }
}

private struct EmptyPayload: Encodable, Sendable {}

extension LiveSession {
  /// `server.getPushStatus`.
  public func pushStatus() async throws -> PushStatus {
    try await call(PushRegistration.statusTag, payload: EmptyPayload(), as: PushStatus.self)
  }

  /// `server.registerPush`: replaces this session's registration.
  public func registerPush(_ registration: PushRegistration) async throws -> PushStatus {
    try await call(PushRegistration.registerTag, payload: registration, as: PushStatus.self)
  }

  /// `server.unregisterPush`.
  public func unregisterPush() async throws -> PushStatus {
    try await call(PushRegistration.unregisterTag, payload: EmptyPayload(), as: PushStatus.self)
  }
}

extension EnvironmentRegistry {
  public func pushStatus(in environmentId: String) async throws(EnvironmentRequestError) -> PushStatus {
    try await request(environmentId) { try await $0.pushStatus() }
  }

  public func registerPush(_ registration: PushRegistration, in environmentId: String) async throws(EnvironmentRequestError) -> PushStatus {
    try await request(environmentId) { try await $0.registerPush(registration) }
  }

  public func unregisterPush(in environmentId: String) async throws(EnvironmentRequestError) -> PushStatus {
    try await request(environmentId) { try await $0.unregisterPush() }
  }
}
