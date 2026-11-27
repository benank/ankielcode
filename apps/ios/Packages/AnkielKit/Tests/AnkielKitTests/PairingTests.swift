import Foundation
import Testing

@testable import AnkielKit

@Suite struct PairingTests {
  @Test func `pairing URL with a fragment token`() throws {
    let target = try PairingInput.resolve("http://127.0.0.1:13773/pair#token=ABCD2345EFGH")
    #expect(target.credential == "ABCD2345EFGH")
    #expect(target.endpoint.httpBaseURL.absoluteString == "http://127.0.0.1:13773/")
    #expect(target.endpoint.wsBaseURL.absoluteString == "ws://127.0.0.1:13773/")
    #expect(target.endpoint.httpURL("/oauth/token").absoluteString == "http://127.0.0.1:13773/oauth/token")
  }

  @Test func `query token is read when the fragment has none`() throws {
    let target = try PairingInput.resolve("https://host.example.com/pair?token=ABCD-EFGH")
    #expect(target.credential == "ABCD-EFGH")
    #expect(target.endpoint.httpBaseURL.absoluteString == "https://host.example.com/")
  }

  @Test func `relay prefix is kept and lowercased; other paths drop`() throws {
    let target = try PairingInput.resolve("https://ankiel-relay.me.workers.dev/h/ABCDEFGHIJKLMNOPQRSTUVWXYZ/#token=X")
    #expect(target.endpoint.httpBaseURL.absoluteString == "https://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/")
    #expect(target.endpoint.socketURL().absoluteString == "wss://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/ws")
    #expect(target.endpoint.relayHostId == "abcdefghijklmnopqrstuvwxyz")
    #expect(
      target.endpoint.resolve(relativeURL: "/api/assets/a.png")?.absoluteString
        == "https://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/api/assets/a.png")
    let notRelay = try PairingInput.resolve("https://h.example.com/h/short/#token=X")
    #expect(notRelay.endpoint.httpBaseURL.absoluteString == "https://h.example.com/")
  }

  @Test func `ws schemes map to http bases and default ports drop`() throws {
    let target = try PairingInput.resolve("wss://host.example.com:443/pair#token=X")
    #expect(target.endpoint.httpBaseURL.absoluteString == "https://host.example.com/")
    #expect(target.endpoint.wsBaseURL.absoluteString == "wss://host.example.com/")
  }

  @Test(arguments: [
    "ankielcode://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A13773%2Fpair%23token%3DABCD2345EFGH",
    "ankielcode-native://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A13773%2Fpair%23token%3DABCD2345EFGH",
    "ankielcode-dev://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A13773%2Fpair%23token%3DABCD2345EFGH",
  ])
  func `app links on any channel unwrap their pairing URL`(link: String) throws {
    let target = try PairingInput.resolve(link)
    #expect(target.credential == "ABCD2345EFGH")
    #expect(target.endpoint.httpBaseURL.absoluteString == "http://127.0.0.1:13773/")
  }

  @Test func `app links must use the pair host`() {
    #expect(PairingInput.appLinkPairingURL("ankielcode://connections?pairingUrl=x") == nil)
    #expect(PairingInput.appLinkPairingURL("other://pair?pairingUrl=x") == nil)
  }

  @Test(arguments: [
    ("ftp://host/pair#token=X", PairingInputError.pairingURLInvalid),
    ("https://host.example.com/pair", PairingInputError.tokenMissing(host: "host.example.com")),
    ("https://host.example.com/pair#token=%20", PairingInputError.tokenMissing(host: "host.example.com")),
    ("   ", PairingInputError.backendURLMissing),
  ])
  func `bad pairing input fails with a reason`(input: String, expected: PairingInputError) {
    #expect(throws: expected) { try PairingInput.resolve(input) }
  }

  @Test func `typed host and code`() throws {
    let lan = try PairingInput.resolve(host: "192.168.1.20:3773", code: " abcd-efgh-jkmn ")
    #expect(lan.endpoint.httpBaseURL.absoluteString == "http://192.168.1.20:3773/")
    #expect(lan.credential == "abcd-efgh-jkmn")
    let named = try PairingInput.resolve(host: "//mac.tailnet.ts.net/some/path", code: "X")
    #expect(named.endpoint.httpBaseURL.absoluteString == "https://mac.tailnet.ts.net/")
    #expect(throws: PairingInputError.codeMissing(host: "mac.tailnet.ts.net")) {
      try PairingInput.resolve(host: "mac.tailnet.ts.net", code: "")
    }
  }

  @Test func `local network detection`() throws {
    #expect(try PairingInput.resolve("http://192.168.1.2/#token=X").endpoint.isLocalNetwork)
    #expect(try PairingInput.resolve("http://127.0.0.1:1/#token=X").endpoint.isLocalNetwork)
    #expect(try !PairingInput.resolve("https://example.com/#token=X").endpoint.isLocalNetwork)
  }
}

@Suite struct CredentialTests {
  @Test func `DPoP tokens renew a minute before expiry; bearer never`() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(!AccessCredential.dpop(accessToken: "a", expiresAt: now.addingTimeInterval(61)).needsRenewal(now: now))
    #expect(AccessCredential.dpop(accessToken: "a", expiresAt: now.addingTimeInterval(60)).needsRenewal(now: now))
    #expect(!AccessCredential.bearer(token: "b").needsRenewal(now: now))
  }

  @Test func `token results map to credentials`() throws {
    let dpop = try decode(
      AccessTokenResult.self,
      json: #"{"access_token":"t","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"DPoP","expires_in":3600,"scope":"orchestration:read orchestration:operate","environment_label":"Mac"}"#)
    let now = Date(timeIntervalSince1970: 0)
    #expect(AccessCredential(dpop, receivedAt: now) == .dpop(accessToken: "t", expiresAt: Date(timeIntervalSince1970: 3600)))
    #expect(dpop.scopes == ["orchestration:read", "orchestration:operate"])
    let bearer = try decode(
      AccessTokenResult.self,
      json: #"{"access_token":"b","token_type":"Bearer","expires_in":"Infinity","scope":"orchestration:read"}"#)
    #expect(AccessCredential(bearer) == .bearer(token: "b"))
  }

  @Test func `stores keep one DPoP key per installation`() throws {
    let store = InMemoryCredentialStore()
    let first = try store.dpopKey()
    let second = try store.dpopKey()
    #expect(first.publicJWK == second.publicJWK)
    try store.set(AccessCredential.bearer(token: "x"), for: CredentialKeys.credential("env"))
    #expect(try store.value(AccessCredential.self, for: CredentialKeys.credential("env")) == .bearer(token: "x"))
  }
}
