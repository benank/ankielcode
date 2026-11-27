import CryptoKit
import Foundation

/// An ES256 key that signs DPoP proofs (RFC 9449). One key per installation, shared by every
/// environment; the server only ever sees the public JWK.
public struct DPoPKey: Sendable {
  public let privateKey: P256.Signing.PrivateKey

  public init() {
    privateKey = P256.Signing.PrivateKey()
  }

  public init(rawRepresentation: Data) throws {
    privateKey = try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation)
  }

  public var rawRepresentation: Data { privateKey.rawRepresentation }

  /// The public JWK coordinates (32 bytes each, from the 65-byte X9.63 point).
  public var publicJWK: PublicJWK {
    let point = privateKey.publicKey.x963Representation
    return PublicJWK(
      x: Data(point[1..<33]).base64URLEncoded,
      y: Data(point[33..<65]).base64URLEncoded)
  }

  /// RFC 7638 thumbprint: base64url(SHA-256) of the members in lexicographic order.
  public var thumbprint: String {
    let jwk = publicJWK
    let canonical = #"{"crv":"P-256","kty":"EC","x":"\#(jwk.x)","y":"\#(jwk.y)"}"#
    return Data(SHA256.hash(data: Data(canonical.utf8))).base64URLEncoded
  }

  /// A proof for one request. `accessToken` (or a WebSocket ticket) adds `ath`.
  public func proof(
    method: String,
    url: URL,
    accessToken: String? = nil,
    nonce: String? = nil,
    issuedAt: Date = .now,
    jti: UUID = UUID()
  ) throws -> String {
    let header = ProofHeader(jwk: publicJWK)
    let claims = ProofClaims(
      htm: method.uppercased(),
      htu: Self.htu(url),
      jti: jti.uuidString.lowercased(),
      iat: Int(issuedAt.timeIntervalSince1970.rounded(.down)),
      ath: accessToken.map { Data(SHA256.hash(data: Data($0.utf8))).base64URLEncoded },
      nonce: nonce)
    let encoder = JSONEncoder.wire
    let signingInput =
      "\(try encoder.encode(header).base64URLEncoded).\(try encoder.encode(claims).base64URLEncoded)"
    let signature = try privateKey.signature(for: Data(signingInput.utf8))
    return "\(signingInput).\(signature.rawRepresentation.base64URLEncoded)"
  }

  /// `htu` as the server normalizes it (WHATWG `URL` without query and fragment): lowercase
  /// scheme and host, default port dropped, `/` for an empty path. `ws(s)` maps to `http(s)`.
  public static func htu(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return url.absoluteString
    }
    let scheme = components.scheme?.lowercased() ?? "https"
    let mapped =
      switch scheme {
      case "ws": "http"
      case "wss": "https"
      default: scheme
      }
    components.scheme = mapped
    components.host = components.host?.lowercased()
    if components.port == (mapped == "https" ? 443 : mapped == "http" ? 80 : -1) {
      components.port = nil
    }
    components.query = nil
    components.fragment = nil
    components.user = nil
    components.password = nil
    if components.percentEncodedPath.isEmpty { components.percentEncodedPath = "/" }
    return components.string ?? url.absoluteString
  }

  public struct PublicJWK: Sendable, Hashable, Codable {
    public var kty = "EC"
    public var crv = "P-256"
    public var x: String
    public var y: String
  }

  private struct ProofHeader: Encodable {
    let typ = "dpop+jwt"
    let alg = "ES256"
    let jwk: PublicJWK
  }

  private struct ProofClaims: Encodable {
    let htm: String
    let htu: String
    let jti: String
    let iat: Int
    let ath: String?
    let nonce: String?
  }
}
