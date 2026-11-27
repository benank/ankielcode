import Foundation
import Testing

@testable import AnkielKit

/// Sharing & access: request encoding against `Fixtures/commands/access-*.json` (decoded strictly
/// by `check-schemas.mjs`), the stream events the server's schemas encode
/// (`Fixtures/access-stream.json`, written by the same script), the reducer and the directory.
@Suite("Access")
@MainActor
struct AccessTests {
  nonisolated static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("access-create-link", "accessCreateLink", CreatePairingLinkRequest(label: "  Harbor iPad ", scopes: PairingScopes.readOnly)),
    ("access-create-link-bare", "accessCreateLink", CreatePairingLinkRequest(label: "   ", scopes: ["orchestration:read"])),
    ("access-revoke-link", "accessRevokeLink", RevokePairingLinkRequest(id: "link-fixture-1")),
    ("access-revoke-client", "accessRevokeClient", RevokeClientRequest(sessionId: "session-fixture-tablet")),
  ]

  @Test("each access request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      try pretty.encode(["schema": .string(sample.schema), "value": value] as JSONValue).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  static func streamFixture() throws -> [AccessStreamEvent] {
    let url = CommandEncodingTests.directory.deletingLastPathComponent().appending(path: "access-stream.json")
    return try JSONDecoder().decode([AccessStreamEvent].self, from: Data(contentsOf: url))
  }

  @Test("the server's encoded stream decodes and reduces like applyAuthAccessStreamEvent")
  func serverStream() throws {
    let events = try Self.streamFixture()
    #expect(events.count == 6)
    let final = events.reduce(AccessSnapshot()) { $1.applied(to: $0) }
    #expect(final.pairingLinks.map(\.id) == [])
    #expect(final.clientSessions.map(\.sessionId).sorted() == ["session-phone", "session-tablet"])
    let phone = try #require(final.clientSessions.first { $0.current })
    #expect(phone.displayName == "Tide iPhone")
    #expect(phone.client.deviceType == "mobile")
    #expect(phone.lastConnectedAt?.date != nil)
    // `permissions` wins over the legacy `scopes` subset.
    #expect(phone.scopes.contains("settings:write"))
    let tablet = try #require(final.clientSessions.first { !$0.current })
    #expect(tablet.lastConnectedAt == nil)
    #expect(tablet.displayName == "Android")
    #expect(final.hasOtherSessions)
  }

  @Test("unknown events and bad rows change nothing")
  func tolerant() throws {
    let json = """
      [{"version":1,"revision":3,"type":"somethingNew","payload":{}},
       {"version":1,"revision":4,"type":"snapshot","payload":{"pairingLinks":[{"id":1}],"clientSessions":[]}}]
      """
    let events = try JSONDecoder().decode([AccessStreamEvent].self, from: Data(json.utf8))
    #expect(events[0] == .unknown("somethingNew"))
    #expect(events[0].applied(to: FakeAccessService.sample()) == FakeAccessService.sample())
    #expect(events[1] == .snapshot(AccessSnapshot()))
  }

  @Test("display order: this device, then live ones, then the most recently seen; expired links hide")
  func ordering() {
    let now = Date.now
    let sample = FakeAccessService.sample(now: now)
    #expect(sample.sortedSessions.map(\.sessionId) == ["session-fixture-phone", "session-fixture-laptop", "session-fixture-tablet"])
    #expect(sample.openLinks(at: now).count == 1)
    #expect(sample.openLinks(at: now.addingTimeInterval(3600)).isEmpty)
  }

  @Test("share links keep a relay prefix, skip loopback, and wrap in the app link")
  func share() throws {
    let relay = try #require(EnvironmentEndpoint(httpBaseURL: URL(string: "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/")!))
    let lan = try #require(EnvironmentEndpoint(httpBaseURL: URL(string: "http://192.168.1.20:3773")!))
    let loop = try #require(EnvironmentEndpoint(httpBaseURL: URL(string: "http://127.0.0.1:3773")!))
    #expect(
      PairingShare.pairingURL(endpoint: relay, code: "TIDE7K3MQ2PX")?.absoluteString
        == "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/pair#token=TIDE7K3MQ2PX")
    let url = try #require(PairingShare.pairingURL(endpoint: lan, code: "TIDE7K3MQ2PX"))
    #expect(url.absoluteString == "http://192.168.1.20:3773/pair#token=TIDE7K3MQ2PX")
    let link = try #require(PairingShare.appLink(url))
    #expect(link.absoluteString == "ankielcode://pair?pairingUrl=http%3A%2F%2F192.168.1.20%3A3773%2Fpair%23token%3DTIDE7K3MQ2PX")
    // The app's own link reader takes it back.
    #expect(PairingInput.appLinkPairingURL(link.absoluteString) == url.absoluteString)
    let routes = PairingShare.shareableRoutes([
      EnvironmentRoute(endpoint: loop), EnvironmentRoute(endpoint: lan), EnvironmentRoute(endpoint: relay, kind: .relay, learned: true),
    ])
    #expect(routes.map(\.kind) == [.relay, .lan])
  }

  @Test("a link can only grant what this device holds")
  func delegatable() {
    let held: Set<String> = ["orchestration:read", "access:write", "filesystem:read"]
    #expect(PairingScopes.delegatable(Set(PairingScopes.standard), holding: held) == ["orchestration:read", "filesystem:read", "access:write"])
    #expect(PairingScopes.delegatable(Set(PairingScopes.readOnly), holding: held) == ["orchestration:read", "filesystem:read"])
  }

  @Test("the directory follows the stream, keeps created codes and applies revokes")
  func directory() async throws {
    let service = FakeAccessService(delay: .zero)
    let directory = AccessDirectory(service: service)
    directory.start()
    defer { directory.stop() }
    await eventually { directory.state == .live }
    #expect(directory.state == .live)
    #expect(directory.snapshot.clientSessions.count == 3)

    let created = try await directory.createLink(label: "Deck tablet", scopes: PairingScopes.readOnly)
    #expect(directory.codes[created.id] == "TIDE7K3MQ2PX")
    #expect(directory.justCreated == created.id)
    await eventually { directory.snapshot.pairingLinks.contains { $0.id == created.id && $0.label == "Deck tablet" } }
    #expect(directory.snapshot.pairingLinks.contains { $0.id == created.id && $0.label == "Deck tablet" })

    try await directory.revokeLink(created.id)
    #expect(directory.codes[created.id] == nil)
    #expect(!directory.snapshot.pairingLinks.contains { $0.id == created.id })

    try await directory.revokeSession("session-fixture-tablet")
    #expect(!directory.snapshot.clientSessions.contains { $0.sessionId == "session-fixture-tablet" })
    // This device cannot revoke itself (the server's 403).
    await #expect(throws: EnvironmentRequestError.self) { try await directory.revokeSession("session-fixture-phone") }
    #expect(service.writes.count == 4)
  }

  @Test("a session without access:read shows as denied, not empty")
  func denied() async {
    let directory = AccessDirectory(service: FakeAccessService(mode: .denied, delay: .zero))
    directory.start()
    defer { directory.stop() }
    await eventually { if case .denied = directory.state { true } else { false } }
    #expect(directory.state == .denied("This session cannot view access."))
  }

  @Test("refused writes leave the list as it was")
  func refused() async throws {
    let directory = AccessDirectory(service: FakeAccessService(mode: .fail, delay: .zero))
    directory.start()
    defer { directory.stop() }
    await eventually { directory.state == .live }
    #expect(directory.state == .live)
    await #expect(throws: EnvironmentRequestError.self) { try await directory.revokeSession("session-fixture-tablet") }
    #expect(directory.snapshot.clientSessions.count == 3)
    #expect(directory.codes.isEmpty)
  }
}
