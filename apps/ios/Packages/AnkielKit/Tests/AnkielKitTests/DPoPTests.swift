import CryptoKit
import Foundation
import Testing

@testable import AnkielKit

@Suite struct DPoPTests {
  let key = DPoPKey()

  func parts(_ proof: String) throws -> (header: JSONValue, claims: JSONValue, signingInput: String, signature: Data) {
    let segments = proof.split(separator: ".").map(String.init)
    try #require(segments.count == 3)
    let header = try decode(JSONValue.self, from: try #require(Data(base64URLEncoded: segments[0])))
    let claims = try decode(JSONValue.self, from: try #require(Data(base64URLEncoded: segments[1])))
    return (header, claims, "\(segments[0]).\(segments[1])", try #require(Data(base64URLEncoded: segments[2])))
  }

  @Test func `proof has the RFC 9449 header and claims and a valid ES256 signature`() throws {
    let url = try #require(URL(string: "https://Host.Example.com:443/api/auth/websocket-ticket/rpc?x=1#frag"))
    let jti = UUID()
    let issuedAt = Date(timeIntervalSince1970: 1_795_700_000.9)
    let proof = try key.proof(method: "post", url: url, accessToken: "token-123", issuedAt: issuedAt, jti: jti)
    let (header, claims, signingInput, signature) = try parts(proof)

    #expect(header["typ"] == "dpop+jwt")
    #expect(header["alg"] == "ES256")
    let jwk = try #require(header["jwk"])
    #expect(jwk["kty"] == "EC")
    #expect(jwk["crv"] == "P-256")
    #expect(jwk["d"] == nil)
    let x = try #require(jwk["x"]?.stringValue.flatMap { Data(base64URLEncoded: $0) })
    let y = try #require(jwk["y"]?.stringValue.flatMap { Data(base64URLEncoded: $0) })
    #expect(x.count == 32 && y.count == 32)

    #expect(claims["htm"] == "POST")
    #expect(claims["htu"] == "https://host.example.com/api/auth/websocket-ticket/rpc")
    #expect(claims["jti"]?.stringValue == jti.uuidString.lowercased())
    #expect(claims["iat"] == 1_795_700_000)
    let ath = Data(SHA256.hash(data: Data("token-123".utf8))).base64URLEncoded
    #expect(claims["ath"]?.stringValue == ath)
    #expect(claims["nonce"] == nil)

    // Verify with the public key rebuilt from the JWK alone, as the server does.
    let publicKey = try P256.Signing.PublicKey(x963Representation: Data([0x04]) + x + y)
    let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: signature)
    #expect(signature.count == 64)
    #expect(publicKey.isValidSignature(ecdsa, for: Data(signingInput.utf8)))
  }

  @Test func `bootstrap proofs carry no ath and every proof has a fresh jti`() throws {
    let url = try #require(URL(string: "http://127.0.0.1:14527/oauth/token"))
    let first = try parts(key.proof(method: "POST", url: url)).claims
    let second = try parts(key.proof(method: "POST", url: url)).claims
    #expect(first["ath"] == nil)
    #expect(first["jti"] != second["jti"])
    #expect(first["htu"] == "http://127.0.0.1:14527/oauth/token")
  }

  @Test(arguments: [
    ("https://h:443/x", "https://h/x"),
    ("http://h:80/x", "http://h/x"),
    ("http://h:8080/x", "http://h:8080/x"),
    ("https://h", "https://h/"),
    ("https://h/", "https://h/"),
    ("https://H.EXAMPLE.com/a/b?q=1#f", "https://h.example.com/a/b"),
    ("wss://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/ws?wsTicket=t", "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/ws"),
    ("ws://192.168.1.20:3773/ws", "http://192.168.1.20:3773/ws"),
    ("ws://h:80/ws", "http://h/ws"),
  ])
  func `htu matches WHATWG normalization`(input: String, expected: String) throws {
    #expect(DPoPKey.htu(try #require(URL(string: input))) == expected)
  }

  @Test func `thumbprint is SHA-256 of the canonical JWK`() throws {
    let jwk = key.publicJWK
    let canonical = #"{"crv":"P-256","kty":"EC","x":"\#(jwk.x)","y":"\#(jwk.y)"}"#
    #expect(key.thumbprint == Data(SHA256.hash(data: Data(canonical.utf8))).base64URLEncoded)
  }

  @Test func `a key survives a raw round trip`() throws {
    let restored = try DPoPKey(rawRepresentation: key.rawRepresentation)
    #expect(restored.publicJWK == key.publicJWK)
  }

  @Test func `base64url has no padding or unsafe characters`() throws {
    let data = Data([0xFB, 0xFF, 0xBF, 0x00])
    #expect(data.base64URLEncoded == "-_-_AA")
    #expect(Data(base64URLEncoded: "-_-_AA") == data)
  }
}

@Suite struct SocketURLTests {
  @Test func `socket URL carries the ticket, a GET proof over the ticket and the protocol params`() throws {
    let key = DPoPKey()
    let connector = EnvironmentConnector(
      store: InMemoryCredentialStore(),
      client: ClientIdentity(label: "Test", deviceType: .phone, os: "iOS", appVersion: "1.0", osMajorVersion: "26"))
    let endpoint = try PairingInput.resolve(pairingURL: "https://relay.example.workers.dev/h/ABCDEFGHIJKLMNOPQRSTUVWXYZ/#token=X").endpoint
    let url = try connector.socketURL(endpoint: endpoint, ticket: "abc.def", key: key)
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.scheme == "wss")
    #expect(components.path == "/h/abcdefghijklmnopqrstuvwxyz/ws")
    let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    #expect(query["wsTicket"] == "abc.def")
    #expect(query["orchestrationProtocol"] == "2")
    #expect(query["frameParts"] == "1")
    #expect(query["clientCapabilities"] == "settingsSecretReferences")
    #expect(query["clientDeviceType"] == "phone")

    let proof = try #require(query["dpop"])
    let claims = try decode(
      JSONValue.self, from: try #require(Data(base64URLEncoded: String(proof.split(separator: ".")[1]))))
    #expect(claims["htm"] == "GET")
    #expect(claims["htu"] == "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/ws")
    #expect(claims["ath"]?.stringValue == Data(SHA256.hash(data: Data("abc.def".utf8))).base64URLEncoded)
  }

  @Test func `form bodies escape plus, apostrophes and spaces`() {
    #expect(FormEncoding.encode([("client_label", "Ben's iPhone+1"), ("a", "b&c=d")]) == "client_label=Ben%27s%20iPhone%2B1&a=b%26c%3Dd")
  }
}
