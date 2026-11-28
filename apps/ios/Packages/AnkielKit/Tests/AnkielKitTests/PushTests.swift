import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// Push registration (RN `pushRegistrationPlan.test.ts`), the alert payload the server's
/// `AgentAlertPush` builds, and the button answers (RN `notificationNavigation.test.ts`).
@Suite("Push")
struct PushTests {
  static let device = PushDevice(token: String(repeating: "ab", count: 32), appId: "com.ankiel.ankielcode.native", apnsEnvironment: .sandbox)
  static let registration = PushRegistration(
    token: device.token, appId: device.appId, apnsEnvironment: .sandbox, kinds: [.completed, .approval, .input], locale: "pt-BR")

  // MARK: Wire

  @Test("the registration encodes exactly as its fixture, which the server's schema decodes")
  func registrationFixture() throws {
    let url = CommandEncodingTests.directory.appending(path: "push-register.json")
    let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(Self.registration))
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      try pretty.encode(["schema": .string("pushRegister"), "value": encoded] as JSONValue).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string("pushRegister"))
    #expect(encoded == fixture["value"])
  }

  @Test("the locale is cut to the server's 35 characters")
  func localeCap() {
    let long = PushRegistration(token: "00", appId: "a", apnsEnvironment: .production, kinds: [], locale: String(repeating: "x", count: 50))
    #expect(long.locale.count == 35)
  }

  @Test("status decodes with and without a registration, keeping unknown kinds")
  func statusDecoding() throws {
    let none = try JSONDecoder().decode(
      PushStatus.self,
      from: Data(#"{"relayConfigured":false,"relayConnected":false,"available":{"ios":false,"android":false},"registration":null}"#.utf8))
    #expect(none == PushStatus(relayConfigured: false, relayConnected: false, availableOnIOS: false, registeredKinds: nil))
    let some = try JSONDecoder().decode(
      PushStatus.self,
      from: Data(
        #"{"relayConfigured":true,"relayConnected":true,"available":{"ios":true,"android":false},"registration":{"platform":"ios","kinds":["completed","later"]}}"#
          .utf8))
    #expect(some.availableOnIOS)
    #expect(some.registeredKinds == [.known(.completed), .unknown("later")])
  }

  // MARK: Registration plan

  @Test("unset asks nothing, off unregisters, on waits for the token and carries kinds and locale")
  func targets() {
    #expect(PushTarget.make(PushPreference(), device: Self.device, locale: "en") == nil)
    #expect(PushTarget.make(PushPreference(enabled: false), device: nil, locale: "en") == PushTarget(key: "off", registration: nil))
    #expect(PushTarget.make(PushPreference(enabled: true), device: nil, locale: "en") == nil)
    let on = PushTarget.make(PushPreference(enabled: true, kinds: [.input, .completed]), device: Self.device, locale: "de")
    #expect(on?.registration?.kinds == [.completed, .input])
    #expect(on?.registration?.locale == "de")
    let relocalized = PushTarget.make(PushPreference(enabled: true, kinds: [.input, .completed]), device: Self.device, locale: "fr")
    #expect(on?.key != relocalized?.key)
  }

  @Test("kind toggles keep the fixed order")
  func kindToggles() {
    let preference = PushPreference(enabled: true).setting(.failed, false).setting(.failed, true).setting(.completed, false)
    #expect(preference.effectiveKinds == [.failed, .approval, .input])
  }

  @Test("each computer is synced once per connection and target; a reconnect registers again")
  func syncState() {
    var state = PushSyncState()
    let target = PushTarget(key: "k1", registration: Self.registration)
    #expect(state.take(connected: ["a", "b"], target: target) == ["a", "b"])
    // In flight: not sent twice.
    #expect(state.take(connected: ["a", "b"], target: target).isEmpty)
    state.settle("a", key: "k1")
    state.settle("b", key: "k1")
    #expect(state.take(connected: ["a", "b"], target: target).isEmpty)
    // A new target goes to everyone again.
    let off = PushTarget(key: "off", registration: nil)
    #expect(state.take(connected: ["a", "b"], target: off) == ["a", "b"])
    state.settle("a", key: "off")
    state.settle("b", key: "off")
    // b drops and comes back: registered again.
    _ = state.take(connected: ["a"], target: off)
    #expect(state.take(connected: ["a", "b"], target: off) == ["b"])
  }

  @Test("an answer from a dropped connection does not count for the next one")
  func staleAnswer() {
    var state = PushSyncState()
    let target = PushTarget(key: "k1", registration: Self.registration)
    #expect(state.take(connected: ["a"], target: target) == ["a"])
    _ = state.take(connected: [], target: target)
    state.settle("a", key: "k1")
    #expect(state.appliedKey("a") == nil)
    #expect(state.take(connected: ["a"], target: target) == ["a"])
  }

  @Test("token hex is lowercase and matches the server's pattern")
  func tokenHex() {
    let hex = PushDevice.hex(Data([0x00, 0xAB, 0x10, 0xFF]))
    #expect(hex == "00ab10ff")
  }

  // MARK: Status rows

  @Test("each computer's row picks the most blocking reason")
  func computerStates() {
    func status(_ configured: Bool, _ connected: Bool, _ ios: Bool, _ kinds: [WireEnum<PushAlertKind>]?) -> PushStatus {
      PushStatus(relayConfigured: configured, relayConnected: connected, availableOnIOS: ios, registeredKinds: kinds)
    }
    #expect(PushComputerState.derive(connected: false, status: nil, error: nil) == .notConnected)
    #expect(PushComputerState.derive(connected: true, status: nil, error: nil) == .checking)
    #expect(PushComputerState.derive(connected: true, status: status(false, false, false, nil), error: nil) == .relayNotSetUp)
    #expect(PushComputerState.derive(connected: true, status: status(true, false, false, nil), error: nil) == .relayOffline)
    #expect(PushComputerState.derive(connected: true, status: status(true, true, false, nil), error: nil) == .noPushKey)
    #expect(PushComputerState.derive(connected: true, status: status(true, true, true, nil), error: nil) == .notRegisteredYet)
    #expect(PushComputerState.derive(connected: true, status: status(true, true, true, [.known(.completed)]), error: nil) == .on)
    #expect(PushComputerState.derive(connected: true, status: nil, error: .rejected(message: "nope")) == .failed("nope"))
  }

  // MARK: APNs environment

  @Test("reads aps-environment from a provisioning profile, else falls back by platform")
  func provisioningProfile() {
    let plist = """
      <?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict><key>Entitlements</key><dict><key>aps-environment</key><string>development</string></dict></dict></plist>
      """
    let profile = Data([0x30, 0x82, 0x01]) + Data(plist.utf8) + Data([0x00, 0xA0])
    #expect(ProvisioningProfile.apnsEnvironment(profile) == .sandbox)
    let production = Data(plist.replacingOccurrences(of: "development", with: "production").utf8)
    #expect(ProvisioningProfile.apnsEnvironment(production) == .production)
    #expect(ProvisioningProfile.resolve(nil, isSimulator: true) == .sandbox)
    #expect(ProvisioningProfile.resolve(nil, isSimulator: false) == .production)
    #expect(ProvisioningProfile.resolve(Data("junk".utf8), isSimulator: false) == .production)
  }

  // MARK: Payload

  /// What `AgentAlertPush.apnsPayload` builds for an approval with buttons.
  static var approvalPayload: [AnyHashable: Any] { [
    "aps": [
      "alert": ["title": "Fix the flaky test", "loc-key": "ANKIEL_PUSH_APPROVAL"], "sound": "default", "thread-id": "env-1/thread-1",
      "interruption-level": "active", "category": "ANKIEL_APPROVAL",
    ],
    "body": ["environmentId": "env-1", "threadId": "thread-1", "kind": "approval", "requestId": "req-1", "requestThreadId": "child-1"],
  ] }

  @Test("reads the ids under body; the group matches aps.thread-id")
  func payload() throws {
    let alert = try #require(AgentAlert(userInfo: Self.approvalPayload))
    #expect(alert.thread == ThreadRef(environmentId: "env-1", threadId: "thread-1"))
    #expect(alert.requestThread == ThreadRef(environmentId: "env-1", threadId: "child-1"))
    #expect(alert.kind == .approval)
    #expect(alert.groupIdentifier == "env-1/thread-1")
    #expect(alert.asksForAnswer)
    #expect(AgentAlertIDs.locKey(.completed) == "ANKIEL_PUSH_COMPLETED")
    #expect(AgentAlert(userInfo: ["aps": ["alert": "hi"]]) == nil)
    #expect(AgentAlert(userInfo: ["body": ["environmentId": "", "threadId": "t"]]) == nil)
    let plain = try #require(AgentAlert(userInfo: ["body": ["environmentId": "e", "threadId": "t", "kind": "completed"]]))
    #expect(plain.requestThread == nil)
  }

  @Test("buttons map to answers on the thread holding the request; an empty reply only opens it")
  func actions() throws {
    let alert = try #require(AgentAlert(userInfo: Self.approvalPayload))
    let approve = try #require(alert.action(identifier: AgentAlertIDs.approve, text: nil))
    #expect(approve.kind == .approve)
    #expect(approve.thread.threadId == "child-1")
    #expect(approve.requestId == "req-1")
    #expect(alert.action(identifier: AgentAlertIDs.deny, text: nil)?.kind == .deny)
    #expect(alert.action(identifier: AgentAlertIDs.reply, text: "  ship it \n")?.text == "ship it")
    #expect(alert.action(identifier: AgentAlertIDs.reply, text: "   ") == nil)
    #expect(alert.action(identifier: "com.apple.UNNotificationDefaultActionIdentifier", text: nil) == nil)
    let plain = AgentAlert(thread: alert.thread, kind: .known(.approval))
    #expect(plain.action(identifier: AgentAlertIDs.approve, text: nil) == nil)
  }

  // MARK: Answers

  static let approvalItem = RequestMake.item("a", type: "approval_request", fields: #""requestId":"r1","requestKind":"command","prompt":"ls""#)
  static let action = AgentNotificationAction(kind: .approve, thread: RequestMake.ref, requestId: "r1")

  static func states(_ values: [NotificationAnswer.ThreadState], thenHang: Bool = true) -> AsyncStream<NotificationAnswer.ThreadState> {
    AsyncStream { continuation in
      for value in values { continuation.yield(value) }
      if !thenHang { continuation.finish() }
    }
  }

  @Test("a warm resume's old live projection waits; the answer goes once the request shows")
  func warmResume() async {
    let old = RequestMake.projection(requests: [], items: [])
    let current = RequestMake.projection(requests: [RequestMake.request("r1")], items: [Self.approvalItem])
    let sent = Mutex<[RequestCommand]>([])
    let outcome = await NotificationAnswer.perform(
      Self.action, states: Self.states([.catchingUp, .live(old), .live(current)]), canOperate: { true },
      send: { command in sent.withLock { $0.append(command) } }, stillPending: { true })
    #expect(outcome == .sent)
    #expect(sent.withLock { $0.map(\.commandId.rawValue) } == ["notification:approve:r1"])
  }

  @Test("a request that never shows times out unsent; a deleted thread or an answered request is skipped")
  func endings() async {
    let never = await NotificationAnswer.perform(
      Self.action, states: Self.states([.live(RequestMake.projection(requests: [], items: []))]), canOperate: { true },
      send: { _ in Issue.record("sent") }, stillPending: { true }, syncTimeout: .milliseconds(50))
    #expect(never == .unsent)
    let deleted = await NotificationAnswer.perform(
      Self.action, states: Self.states([.deleted]), canOperate: { true }, send: { _ in Issue.record("sent") }, stillPending: { true })
    #expect(deleted == .skipped)
    let answered = RequestMake.projection(requests: [RequestMake.request("r1", status: "resolved")], items: [Self.approvalItem])
    let elsewhere = await NotificationAnswer.perform(
      Self.action, states: Self.states([.live(answered)]), canOperate: { true }, send: { _ in Issue.record("sent") }, stillPending: { true })
    #expect(elsewhere == .skipped)
  }

  @Test("a refused send is reported only while the request still waits")
  func refusedSend() async {
    struct Refused: Error {}
    let pending = RequestMake.projection(requests: [RequestMake.request("r1")], items: [Self.approvalItem])
    let unsent = await NotificationAnswer.perform(
      Self.action, states: Self.states([.live(pending)]), canOperate: { true }, send: { _ in throw Refused() }, stillPending: { true })
    #expect(unsent == .unsent)
    let raced = await NotificationAnswer.perform(
      Self.action, states: Self.states([.live(pending)]), canOperate: { true }, send: { _ in throw Refused() }, stillPending: { false })
    #expect(raced == .skipped)
    let slow = await NotificationAnswer.perform(
      Self.action, states: Self.states([.live(pending)]), canOperate: { true },
      send: { _ in try await Task.sleep(for: .seconds(30)) }, stillPending: { true }, sendTimeout: .milliseconds(50))
    #expect(slow == .unsent)
  }

  @Test("an approval alert clears once neither its thread nor a child of it waits")
  func clearing() throws {
    func shell(_ id: String, parent: String?, asking: Bool) throws -> ThreadShell {
      var row = try Fixture.thread(id, title: id)
      row.lineage.parentThreadId = parent
      if asking {
        row.pendingRuntimeRequest = .init(id: "r", kind: .known(.command), createdAt: WireTimestamp(rawValue: "2026-06-01T00:00:00.000Z"))
      }
      return row
    }
    let threads = [try shell("parent", parent: nil, asking: false), try shell("child", parent: "parent", asking: true), try shell("idle", parent: nil, asking: false)]
    let waiting = AlertClearing.waitingThreads(environmentId: "e", threads: threads)
    #expect(waiting == [ThreadRef(environmentId: "e", threadId: "parent"), ThreadRef(environmentId: "e", threadId: "child")])
    let onParent = AgentAlert(thread: ThreadRef(environmentId: "e", threadId: "parent"), kind: .known(.approval))
    let onIdle = AgentAlert(thread: ThreadRef(environmentId: "e", threadId: "idle"), kind: .known(.input))
    let finished = AgentAlert(thread: ThreadRef(environmentId: "e", threadId: "idle"), kind: .known(.completed))
    #expect(!AlertClearing.isStale(onParent, waiting: waiting))
    #expect(AlertClearing.isStale(onIdle, waiting: waiting))
    #expect(!AlertClearing.isStale(finished, waiting: waiting))
  }
}
