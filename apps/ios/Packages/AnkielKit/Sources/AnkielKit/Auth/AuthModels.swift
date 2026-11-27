import Foundation

/// `POST /oauth/token` success.
public struct AccessTokenResult: Sendable, Hashable, Decodable {
  public var accessToken: String
  public var tokenType: WireEnum<TokenType>
  /// Seconds.
  public var expiresIn: WireNumber
  public var scope: String
  public var environmentLabel: String?

  public enum TokenType: String, Sendable {
    case bearer = "Bearer"
    case dpop = "DPoP"
  }

  public var scopes: [String] { scope.split(separator: " ").map(String.init) }

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case tokenType = "token_type"
    case expiresIn = "expires_in"
    case scope
    case environmentLabel = "environment_label"
  }
}

/// `POST /api/auth/websocket-ticket/rpc` success.
public struct WebSocketTicket: Sendable, Hashable, Decodable {
  public var ticket: String
  public var expiresAt: WireTimestamp
}

/// What the client holds for one paired environment.
public enum AccessCredential: Sendable, Hashable, Codable {
  /// A 30-day bearer token (paired without DPoP); re-pair when it expires.
  case bearer(token: String)
  /// A DPoP-bound token, renewable inside the server's sliding window.
  case dpop(accessToken: String, expiresAt: Date)

  public var token: String {
    switch self {
    case .bearer(let token): token
    case .dpop(let accessToken, _): accessToken
    }
  }

  /// Renew when within a minute of expiry (`DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS`).
  public func needsRenewal(now: Date = .now) -> Bool {
    guard case .dpop(_, let expiresAt) = self else { return false }
    return expiresAt.addingTimeInterval(-60) <= now
  }

  public init(_ result: AccessTokenResult, receivedAt: Date = .now) {
    switch result.tokenType {
    case .known(.dpop):
      let seconds = result.expiresIn.value.isFinite ? result.expiresIn.value : 3600
      self = .dpop(accessToken: result.accessToken, expiresAt: receivedAt.addingTimeInterval(seconds))
    default:
      self = .bearer(token: result.accessToken)
    }
  }
}

/// A paired environment as saved on the device. Secrets live in the `CredentialStore`.
public struct SavedEnvironment: Sendable, Hashable, Codable, Identifiable {
  public var environmentId: String
  public var label: String
  public var endpoint: EnvironmentEndpoint
  public var serverVersion: String
  public var pairedAt: Date

  public var id: String { environmentId }

  public init(
    environmentId: String, label: String, endpoint: EnvironmentEndpoint, serverVersion: String,
    pairedAt: Date = .now
  ) {
    self.environmentId = environmentId
    self.label = label
    self.endpoint = endpoint
    self.serverVersion = serverVersion
    self.pairedAt = pairedAt
  }
}

/// Client metadata sent with the pairing exchange; labels the session in the server's
/// Connections list.
public struct ClientIdentity: Sendable, Hashable {
  public var label: String
  public var deviceType: DeviceType
  public var os: String
  public var appVersion: String
  public var osMajorVersion: String?
  public var deviceModel: String?

  public enum DeviceType: String, Sendable {
    case phone, tablet, desktop, unknown

    /// The token exchange names phones `mobile`.
    var exchangeValue: String { self == .phone ? "mobile" : rawValue }
  }

  public init(
    label: String, deviceType: DeviceType, os: String, appVersion: String,
    osMajorVersion: String? = nil, deviceModel: String? = nil
  ) {
    self.label = label
    self.deviceType = deviceType
    self.os = os
    self.appVersion = appVersion
    self.osMajorVersion = osMajorVersion
    self.deviceModel = deviceModel
  }
}
