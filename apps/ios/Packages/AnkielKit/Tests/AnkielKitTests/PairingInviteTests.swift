import Foundation
import Testing

@testable import AnkielKit

/// Device pairing invites: requests against `Fixtures/commands/pairing-invite-*.json` (decoded
/// strictly by `check-schemas.mjs`), the server's encoded answers and `remote.ts`'s payload
/// handling (`Fixtures/pairing-invite-golden.json`, same script), the page rules and the session.
extension JSONValue {
  fileprivate var items: [JSONValue]? { if case .array(let items) = self { items } else { nil } }
  fileprivate var fields: [String: JSONValue]? { if case .object(let fields) = self { fields } else { nil } }
}

@Suite("Pairing invites")
@MainActor
struct PairingInviteTests {
  nonisolated static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("pairing-invite-create", "pairingInviteCreate", CreatePairingInviteRequest(scopes: ["orchestration:read", "orchestration:operate", "access:read"])),
    ("pairing-invite-create-bare", "pairingInviteCreate", CreatePairingInviteRequest(scopes: nil)),
    ("pairing-invite-approve", "pairingInviteApprove", ApprovePairingInviteRequest(verificationCode: "482-913")),
    ("pairing-invite-deny", "pairingInviteDeny", EmptyObject()),
    ("pairing-invite-claim", "pairingInviteClaim", ClaimPairingInviteRequest(clientLabel: "ankiel-probe claimant", clientDeviceType: "desktop", clientOs: "macOS")),
  ]

  @Test("each invite request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
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

  static func golden() throws -> JSONValue {
    let url = CommandEncodingTests.directory.deletingLastPathComponent().appending(path: "pairing-invite-golden.json")
    return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
  }

  static func decode<T: Decodable>(_ value: JSONValue?, as _: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONEncoder().encode(try #require(value)))
  }

  @Test("the server's encoded answers decode")
  func responses() throws {
    let responses = try Self.golden()["responses"]
    let created = try Self.decode(responses?["created"], as: PairingInviteCreated.self)
    #expect(created.inviteId == "invite-tide-1")
    #expect(created.expiresAt.rawValue == "2026-11-27T09:02:00.000Z")
    #expect(try Self.decode(responses?["pending"], as: PairingInviteStatus.self).status == .pending)
    let claimed = try Self.decode(responses?["claimed"], as: PairingInviteStatus.self)
    #expect(claimed.status == .claimed)
    #expect(claimed.claim?.clientLabel == "Harbor MacBook Pro")
    #expect(claimed.claim?.verificationCode == "482-913")
    #expect(claimed.scopes == ["orchestration:read", "orchestration:operate", "access:read"])
    let bare = try Self.decode(responses?["claimedBare"], as: PairingInviteStatus.self)
    #expect(bare.claim?.clientLabel == nil)
    #expect(bare.claim?.clientDeviceType == "unknown")
    #expect(try Self.decode(responses?["approved"], as: PairingInviteApproved.self).status == "approved")
    #expect(try Self.decode(responses?["denied"], as: PairingInviteDenied.self).status == "denied")
    #expect(try Self.decode(responses?["claimClaimed"], as: PairingInviteClaimed.self).verificationCode == "482-913")
    let approved = try Self.decode(responses?["claimApproved"], as: PairingInviteClaimStatus.self)
    #expect(approved.credential == "TIDE7K3MQ2PX")
    #expect(try Self.decode(responses?["claimExpired"], as: PairingInviteClaimStatus.self).credential == nil)
  }

  @Test("an unknown status keeps its raw value")
  func unknownStatus() throws {
    let raw = #"{"inviteId":"i","expiresAt":"2026-11-27T09:02:00.000Z","scopes":[],"status":"paused"}"#
    let status = try JSONDecoder().decode(PairingInviteStatus.self, from: Data(raw.utf8))
    #expect(status.status == .unknown("paused"))
  }

  static func payload(_ input: JSONValue?) -> PairingInvitePayload {
    PairingInvitePayload(
      inviteId: input?["inviteId"]?.stringValue ?? "", environmentId: input?["environmentId"]?.stringValue ?? "",
      baseUrl: input?["baseUrl"]?.stringValue ?? "", label: input?["label"]?.stringValue, expiresAt: input?["expiresAt"]?.stringValue)
  }

  @Test("app link, file and Handoff userInfo match remote.ts byte for byte")
  func payloadsMatchRemote() throws {
    let accepted = try #require(try Self.golden()["accepted"]?.items)
    #expect(accepted.count == 5)
    for entry in accepted {
      let invite = try #require(Self.payload(entry["input"]).validated())
      #expect(invite.baseUrl == entry["normalized"]?["baseUrl"]?.stringValue)
      #expect(invite.fileJSON == entry["file"]?.stringValue)
      #expect(invite.appLink() == entry["appLink"]?.stringValue)
      let userInfo = try #require(entry["userInfo"]?.fields).mapValues { $0.stringValue ?? "" }
      #expect(invite.userInfo == userInfo)
    }
  }

  @Test("payloads remote.ts refuses are refused")
  func refusedPayloads() throws {
    let refused = try #require(try Self.golden()["refused"]?.items)
    #expect(refused.count == 15)
    for entry in refused {
      #expect(Self.payload(entry["input"]).validated() == nil, "\(entry)")
    }
  }

  // MARK: Rules

  @Test("default scopes: omitted when holding all or unknown, else the held standard ones")
  func defaultScopes() {
    #expect(PairingInviteRules.defaultScopes(held: nil) == nil)
    #expect(PairingInviteRules.defaultScopes(held: Set(AuthScope.grants)) == nil)
    #expect(PairingInviteRules.defaultScopes(held: Set(AuthScope.grants + ["future:scope"])) == nil)
    #expect(PairingInviteRules.defaultScopes(held: ["future:scope"]) == nil)
    #expect(PairingInviteRules.defaultScopes(held: ["access:write", "orchestration:read"]) == ["orchestration:read", "access:write"])
    #expect(PairingInviteRules.grantsEverything(AuthScope.grants))
    #expect(!PairingInviteRules.grantsEverything(["orchestration:read"]))
  }

  static func route(_ url: String, _ kind: ConnectionRouteKind? = nil) -> EnvironmentRoute {
    EnvironmentRoute(endpoint: EnvironmentEndpoint(httpBaseURL: URL(string: url)!)!, kind: kind)
  }

  @Test("shareable base URL: connected relay, then active https route, then first http, then a configured relay")
  func shareableBaseURL() {
    let lan = Self.route("http://192.168.1.20:3773/")
    let tailnet = Self.route("https://studio.tail1234.ts.net/", .tailnet)
    let loopback = Self.route("http://127.0.0.1:14527/")
    let localhost = Self.route("http://tide.localhost:3773/")
    let relayURL = "https://ankiel-relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/"
    let up = RelayStatus(configured: true, connected: true, publicBaseUrl: relayURL)
    let down = RelayStatus(configured: true, connected: false, publicBaseUrl: relayURL)
    let insecure = RelayStatus(configured: true, connected: true, publicBaseUrl: "http://relay.example.com/")

    #expect(PairingInviteRules.shareableBaseURL(relay: up, routes: [lan], activeRoute: lan) == relayURL)
    #expect(PairingInviteRules.shareableBaseURL(relay: nil, routes: [lan, tailnet], activeRoute: lan) == "https://studio.tail1234.ts.net/")
    #expect(PairingInviteRules.shareableBaseURL(relay: nil, routes: [loopback, lan], activeRoute: loopback) == "http://192.168.1.20:3773/")
    #expect(PairingInviteRules.shareableBaseURL(relay: nil, routes: [loopback, localhost], activeRoute: nil) == nil)
    #expect(PairingInviteRules.shareableBaseURL(relay: down, routes: [loopback], activeRoute: nil) == relayURL)
    #expect(PairingInviteRules.shareableBaseURL(relay: down, routes: [lan], activeRoute: nil) == "http://192.168.1.20:3773/")
    // A relay route equal to the disconnected relay is skipped among routes, then offered last.
    #expect(PairingInviteRules.shareableBaseURL(relay: down, routes: [Self.route(relayURL, .relay)], activeRoute: nil) == relayURL)
    #expect(PairingInviteRules.shareableBaseURL(relay: insecure, routes: [], activeRoute: nil) == nil)
  }

  @Test("hosts another device cannot dial are never shared")
  func unshareableHosts() {
    for host in ["localhost", "127.0.0.1", "127.9.8.7", "::1", "[::1]", "0.0.0.0", "::", "app.localhost", "localhost.", ""] {
      #expect(!PairingInviteRules.isShareable(host: host), "\(host)")
    }
    for host in ["192.168.1.20", "studio.tail1234.ts.net", "128.0.0.1", "relay.example.com"] {
      #expect(PairingInviteRules.isShareable(host: host), "\(host)")
    }
  }

  @Test("countdown rounds seconds up, m:ss")
  func countdown() {
    #expect(PairingInviteRules.countdown(120) == "2:00")
    #expect(PairingInviteRules.countdown(119.2) == "2:00")
    #expect(PairingInviteRules.countdown(61) == "1:01")
    #expect(PairingInviteRules.countdown(0.4) == "0:01")
    #expect(PairingInviteRules.countdown(-3) == "0:00")
  }

  @Test("device names without a label")
  func deviceFallback() {
    #expect(PairingInviteRules.deviceFallback(type: "desktop", os: " macOS ") == .desktop(os: "macOS"))
    #expect(PairingInviteRules.deviceFallback(type: "desktop", os: "unknown") == .desktop(os: nil))
    #expect(PairingInviteRules.deviceFallback(type: "tablet", os: "") == .tablet(os: nil))
    #expect(PairingInviteRules.deviceFallback(type: "bot", os: "Linux") == .bot)
    #expect(PairingInviteRules.deviceFallback(type: "unknown", os: "Linux") == .other(os: "Linux"))
    #expect(PairingInviteRules.deviceFallback(type: "watch", os: "Unknown") == .other(os: nil))
  }

  @Test("refusals are classified like classifyPairingPollError")
  func pollOutcome() {
    func rejected(_ tag: String) -> PairingInviteError { .rejected(tag: tag, reason: nil, message: nil) }
    #expect(rejected("EnvironmentResourceNotFoundError").pollOutcome == .expired)
    #expect(rejected("EnvironmentAuthInvalidError").pollOutcome == .permanent)
    #expect(rejected("EnvironmentScopeRequiredError").pollOutcome == .permanent)
    #expect(rejected("EnvironmentOperationForbiddenError").pollOutcome == .permanent)
    #expect(rejected("EnvironmentInternalError").pollOutcome == .transient)
    #expect(PairingInviteError.notConnected.pollOutcome == .transient)
    #expect(PairingInviteError.failed("timed out").pollOutcome == .transient)
    let server = PairingInviteError(
      RpcError.failed(RpcFailure(error: ["_tag": "EnvironmentOperationForbiddenError", "reason": "pairing_invite_limit_reached"])))
    #expect(server.reason == "pairing_invite_limit_reached")
  }
}

// MARK: - The session

/// A scripted invite service: each poll answers the next scripted result (the last repeats).
@MainActor
final class ScriptedInviteService: PairingInviteService {
  var createResult: Result<PairingInviteCreated, PairingInviteError> = .success(
    PairingInviteCreated(inviteId: "invite-1", expiresAt: WireTimestamp(rawValue: "2099-01-01T00:02:00.000Z"), scopes: AuthScope.grants))
  var polls: [Result<PairingInviteStatus, PairingInviteError>] = []
  var approveResult: Result<PairingInviteApproved, PairingInviteError> = .success(
    PairingInviteApproved(status: "approved", grantExpiresAt: WireTimestamp(rawValue: "2099-01-01T00:04:00.000Z")))
  var writes: [String] = []
  var pollCount = 0
  /// Holds `status` until released, to test a decision racing a poll.
  var holdPoll: CheckedContinuation<Void, Never>?
  var holdNextPoll = false
  var createGate: CheckedContinuation<Void, Never>?
  var holdCreate = false

  func create(_ request: CreatePairingInviteRequest) async throws(PairingInviteError) -> PairingInviteCreated {
    writes.append("create \(request.scopes?.joined(separator: ",") ?? "-")")
    if holdCreate { await withCheckedContinuation { createGate = $0 } }
    return try createResult.get()
  }

  func status(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteStatus {
    pollCount += 1
    if holdNextPoll {
      holdNextPoll = false
      await withCheckedContinuation { holdPoll = $0 }
    }
    let next = polls.count > 1 ? polls.removeFirst() : polls.first ?? .success(Self.status(.pending))
    return try next.get()
  }

  func approve(_ inviteId: String, code: String) async throws(PairingInviteError) -> PairingInviteApproved {
    writes.append("approve \(inviteId) \(code)")
    return try approveResult.get()
  }

  func deny(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteDenied {
    writes.append("deny \(inviteId)")
    return PairingInviteDenied(status: "denied")
  }

  static let claim = PairingInviteClaim(clientLabel: "Harbor MacBook Pro", clientDeviceType: "desktop", clientOs: "macOS", verificationCode: "482-913")

  static func status(_ phase: PairingInviteStatus.Phase, claim: PairingInviteClaim? = nil) -> PairingInviteStatus {
    PairingInviteStatus(
      inviteId: "invite-1", expiresAt: WireTimestamp(rawValue: "2099-01-01T00:02:00.000Z"), scopes: AuthScope.grants, status: phase,
      claim: claim)
  }
}

@Suite("Pairing invite session")
@MainActor
struct PairingInviteSessionTests {
  func session(_ service: ScriptedInviteService, label: String = " Studio Mac ") -> PairingInviteSession {
    PairingInviteSession(
      service: service, environmentId: "env-tide", label: label, baseURL: "http://192.168.1.20:3773/", scopes: ["orchestration:read"],
      interval: .milliseconds(5))
  }

  func wait(until condition: @MainActor () -> Bool) async {
    for _ in 0..<2_000 where !condition() { await Task.yield(); try? await Task.sleep(for: .milliseconds(1)) }
  }

  @Test("create, wait, claim (one haptic), approve")
  func approvePath() async throws {
    let service = ScriptedInviteService()
    service.polls = [
      .success(ScriptedInviteService.status(.pending)), .success(ScriptedInviteService.status(.claimed)),
      .success(ScriptedInviteService.status(.claimed, claim: ScriptedInviteService.claim)),
    ]
    let session = session(service)
    session.start()
    await wait { session.invite != nil }
    let invite = try #require(session.invite)
    #expect(invite.label == "Studio Mac")
    #expect(invite.expiresAt == "2099-01-01T00:02:00.000Z")
    #expect(service.writes == ["create orchestration:read"])
    await wait { if case .claimed = session.phase { true } else { false } }
    await wait { service.pollCount >= 6 }
    #expect(session.claims == 1)
    await session.approve()
    #expect(session.phase == .approved)
    #expect(session.approvals == 1)
    #expect(service.writes.last == "approve invite-1 482-913")
    let polled = service.pollCount
    try await Task.sleep(for: .milliseconds(40))
    #expect(service.pollCount == polled)
    session.stop()
    try await Task.sleep(for: .milliseconds(10))
    #expect(!service.writes.contains("deny invite-1"))
  }

  @Test("a claimed status without its claim keeps waiting")
  func claimedWithoutClaim() async throws {
    let service = ScriptedInviteService()
    service.polls = [.success(ScriptedInviteService.status(.claimed))]
    let session = session(service)
    session.start()
    await wait { service.pollCount >= 3 }
    if case .pending = session.phase {} else { Issue.record("left pending: \(session.phase)") }
    session.stop()
  }

  @Test("deny ends as denied; a failed decision keeps the claim and says why")
  func denyAndFailedApprove() async throws {
    let service = ScriptedInviteService()
    service.polls = [.success(ScriptedInviteService.status(.claimed, claim: ScriptedInviteService.claim))]
    service.approveResult = .failure(.rejected(tag: "EnvironmentRequestInvalidError", reason: "pairing_invite_verification_code_mismatch", message: nil))
    let session = session(service)
    session.start()
    await wait { if case .claimed = session.phase { true } else { false } }
    await session.approve()
    if case .claimed = session.phase {} else { Issue.record("lost the claim") }
    #expect(session.actionError?.reason == "pairing_invite_verification_code_mismatch")
    #expect(session.decision == nil)
    await session.deny()
    #expect(session.phase == .ended(.denied))
    #expect(session.actionError == nil)
  }

  @Test("end states from the poll: expired, cancelled, a 404, a permanent refusal; transient errors keep polling")
  func endStates() async throws {
    for (answer, expected) in [
      (Result<PairingInviteStatus, PairingInviteError>.success(ScriptedInviteService.status(.expired)), PairingInviteSession.Phase.ended(.expired)),
      (.success(ScriptedInviteService.status(.cancelled)), .ended(.cancelled)),
      (.failure(.rejected(tag: "EnvironmentResourceNotFoundError", reason: "pairing_invite_not_found", message: nil)), .ended(.expired)),
      (.failure(.rejected(tag: "EnvironmentScopeRequiredError", reason: nil, message: "Needs access:write")),
        .failed(.rejected(tag: "EnvironmentScopeRequiredError", reason: nil, message: "Needs access:write"))),
    ] {
      let service = ScriptedInviteService()
      service.polls = [.failure(.failed("timed out")), .failure(.notConnected), answer]
      let session = session(service)
      session.start()
      await wait { session.invite == nil && service.pollCount > 0 }
      #expect(session.phase == expected)
      #expect(service.pollCount == 3)
      session.stop()
      try await Task.sleep(for: .milliseconds(5))
      #expect(!service.writes.contains("deny invite-1"), "an ended invite is not denied again")
    }
  }

  @Test("create refused: the reason survives for the message")
  func createRefused() async {
    let service = ScriptedInviteService()
    service.createResult = .failure(.rejected(tag: "EnvironmentOperationForbiddenError", reason: "pairing_invite_limit_reached", message: nil))
    let session = session(service)
    session.start()
    await wait { if case .failed = session.phase { true } else { false } }
    if case .failed(let error) = session.phase { #expect(error.reason == "pairing_invite_limit_reached") } else { Issue.record("\(session.phase)") }
    #expect(service.pollCount == 0)
  }

  @Test("leaving denies a live invite; leaving while creating denies it once it exists")
  func stopDenies() async throws {
    let service = ScriptedInviteService()
    let live = session(service)
    live.start()
    await wait { live.invite != nil }
    live.stop()
    await wait { service.writes.contains("deny invite-1") }
    #expect(service.writes == ["create orchestration:read", "deny invite-1"])

    let slow = ScriptedInviteService()
    slow.holdCreate = true
    let early = session(slow)
    early.start()
    await wait { slow.createGate != nil }
    early.stop()
    slow.createGate?.resume()
    await wait { slow.writes.contains("deny invite-1") }
    #expect(slow.writes == ["create orchestration:read", "deny invite-1"])
    #expect(early.phase == .creating)
    #expect(slow.pollCount == 0)
  }

  @Test("background and offline pause polling; coming back polls at once")
  func pausesWhileInactive() async throws {
    let service = ScriptedInviteService()
    let session = PairingInviteSession(
      service: service, environmentId: "env-tide", label: "Studio", baseURL: "http://192.168.1.20:3773/", scopes: nil, interval: .seconds(30))
    session.setActive(false)
    session.start()
    await wait { session.invite != nil }
    #expect(service.pollCount == 0)
    session.setActive(true)
    await wait { service.pollCount == 1 }
    #expect(service.pollCount == 1)
    session.setConnected(false)
    session.setConnected(true)
    await wait { service.pollCount == 2 }
    #expect(service.pollCount == 2)
    session.stop()
  }

  @Test("a poll that returns during a decision is ignored")
  func pollDuringDecision() async throws {
    let service = ScriptedInviteService()
    service.polls = [
      .success(ScriptedInviteService.status(.claimed, claim: ScriptedInviteService.claim)),
      .success(ScriptedInviteService.status(.cancelled)),
    ]
    let session = session(service)
    session.start()
    await wait { if case .claimed = session.phase { true } else { false } }
    service.holdNextPoll = true
    await wait { service.holdPoll != nil }
    async let approving: Void = session.approve()
    service.holdPoll?.resume()
    await approving
    #expect(session.phase == .approved)
  }

  @Test("a label the receiver would refuse is dropped, not fatal")
  func longLabel() async {
    let service = ScriptedInviteService()
    let session = session(service, label: String(repeating: "é", count: 200))
    session.start()
    await wait { session.invite != nil }
    #expect(session.invite?.label == nil)
    #expect(session.invite?.validated() != nil)
    session.stop()
  }
}
