import Foundation
import Testing

@testable import AnkielKit

/// The RN app's `ConnectionCatalogDocument` (client-runtime `storageDocument.ts`) as saved by
/// `expo-secure-store`, turned into native records and credentials.
@Suite("RN app import")
struct RNAppImportTests {
  static let catalog = """
    {"schemaVersion":1,
     "targets":[],
     "profiles":[
       {"_tag":"BearerConnectionProfile","connectionId":"lan","environmentId":"env-1","label":"Studio",
        "httpBaseUrl":"http://192.168.0.10:3773","wsBaseUrl":"ws://192.168.0.10:3773"},
       {"_tag":"BearerConnectionProfile","connectionId":"relay","environmentId":"env-1","label":"Studio",
        "httpBaseUrl":"https://relay.example.dev/h/abcdefghijklmnopqrstuvwxyz/","wsBaseUrl":"wss://relay.example.dev/h/abcdefghijklmnopqrstuvwxyz/","network":"relay"},
       {"_tag":"SshConnectionProfile","connectionId":"ssh","environmentId":"env-2","label":"Box","target":{}},
       {"_tag":"BearerConnectionProfile","connectionId":"old","environmentId":"env-3","label":"Laptop",
        "httpBaseUrl":"http://10.0.0.2:3773","wsBaseUrl":"ws://10.0.0.2:3773"},
       {"_tag":"BearerConnectionProfile","connectionId":"none","environmentId":"env-4","label":"Unsigned",
        "httpBaseUrl":"http://10.0.0.3:3773","wsBaseUrl":"ws://10.0.0.3:3773"}
     ],
     "credentials":[
       {"connectionId":"lan","credential":{"_tag":"DpopConnectionCredential","accessToken":"dpop-token","expiresAtEpochMs":1800000000000}},
       {"connectionId":"ssh","credential":{"_tag":"BearerConnectionCredential","token":"ssh-token"}},
       {"connectionId":"old","credential":{"_tag":"BearerConnectionCredential","token":"bearer-token"}}
     ],
     "disabledEnvironmentIds":["env-3"]}
    """

  @Test("computers keep their routes, credentials and off state; SSH and unsigned entries are skipped")
  func catalog() throws {
    let key = DPoPKey()
    let jwk = #"{"kty":"EC","crv":"P-256","x":"","y":"","d":"\#(key.rawRepresentation.base64URLEncoded)"}"#
    let imported = try RNAppImport(catalog: Data(Self.catalog.utf8), dpopJWK: Data(jwk.utf8))

    #expect(imported.environments.map(\.record.environmentId) == ["env-1", "env-3"])
    let studio = imported.environments[0]
    #expect(studio.record.label == "Studio")
    #expect(studio.record.routes.map(\.endpoint.httpBaseURL.absoluteString) == [
      "http://192.168.0.10:3773/", "https://relay.example.dev/h/abcdefghijklmnopqrstuvwxyz/",
    ])
    #expect(studio.record.routes.map(\.learned) == [false, true])
    #expect(studio.credential == .dpop(accessToken: "dpop-token", expiresAt: Date(timeIntervalSince1970: 1_800_000_000)))
    #expect(studio.record.enabled == nil)
    #expect(imported.environments[1].credential == .bearer(token: "bearer-token"))
    #expect(imported.environments[1].record.enabled == false)
    #expect(imported.dpopKey == key.rawRepresentation)
  }
}
