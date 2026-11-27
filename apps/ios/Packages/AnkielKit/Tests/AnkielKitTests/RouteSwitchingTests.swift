import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// Moving between routes as the phone changes networks (RN supervisor `checkBetterRoutes`), the
/// silent-socket check, and the route order and editing rules.
@Suite struct RouteSwitchingTests {
  static func route(_ url: String, kind: ConnectionRouteKind? = nil, learned: Bool = false, manual: Bool = false) -> EnvironmentRoute {
    EnvironmentRoute(endpoint: EnvironmentEndpoint(httpBaseURL: URL(string: url)!)!, kind: kind, learned: learned, manual: manual)
  }

  static let paired = route("https://studio.example.com/")
  static let lan = route("http://192.168.1.20:3773/", learned: true)
  static let relay = route("https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/", kind: .relay, learned: true)

  // MARK: Order

  @Test func `default preference is local, then paired, then the rest; the last route goes first to connect`() {
    let routes = [Self.paired, Self.relay, Self.lan]
    #expect(RouteSelection.preference(routes).map(\.id) == [Self.lan.id, Self.paired.id, Self.relay.id])
    #expect(RouteSelection.order(routes, lastUsed: Self.relay.id).map(\.id) == [Self.relay.id, Self.lan.id, Self.paired.id])
    #expect(RouteSelection.better(than: Self.relay, in: routes, order: nil).map(\.id) == [Self.lan.id, Self.paired.id])
    #expect(RouteSelection.better(than: Self.lan, in: routes, order: nil).isEmpty)
  }

  @Test func `a user order wins, and routes it does not name keep their default rank after it`() {
    let routes = [Self.paired, Self.relay, Self.lan]
    let order = [Self.relay.id]
    #expect(RouteSelection.preference(routes, order: order).map(\.id) == [Self.relay.id, Self.lan.id, Self.paired.id])
    #expect(RouteSelection.better(than: Self.relay, in: routes, order: order).isEmpty)
  }

  @Test func `only added addresses are removable, and clear text needs a local or clear-text pairing`() {
    #expect(!RouteSelection.canRemove(Self.paired))
    #expect(!RouteSelection.canRemove(Self.lan))
    #expect(RouteSelection.canRemove(Self.route("https://studio.vpn.example/", manual: true)))
    let publicHTTP = EnvironmentEndpoint(httpBaseURL: URL(string: "http://203.0.113.9:3773/")!)!
    #expect(!RouteSelection.allowsCredential(publicHTTP, routes: [Self.paired]))
    #expect(RouteSelection.allowsCredential(publicHTTP, routes: [Self.route("http://studio.example.com/")]))
    #expect(RouteSelection.allowsCredential(Self.lan.endpoint, routes: [Self.paired]))
    #expect(RouteSelection.allowsCredential(Self.paired.endpoint, routes: [Self.paired]))
  }

  @Test func `older saved routes without the manual flag still decode`() throws {
    let json = #"{"kind":"lan","endpoint":{"httpBaseURL":"http://192.168.1.20:3773/","wsBaseURL":"ws://192.168.1.20:3773/"},"learned":true}"#
    let route = try JSONDecoder().decode(EnvironmentRoute.self, from: Data(json.utf8))
    #expect(route.learned && !route.manual)
  }

  // MARK: Supervisor

  let clock = TestClock()

  @Test func `on the relay, a LAN route that answers is connected first and then replaces the session`() async throws {
    let link = SwitchingLink(routes: [Self.paired, Self.relay, Self.lan])
    let onRelay = try FakeSession(route: Self.relay)
    let onLAN = try FakeSession(route: Self.lan)
    link.script(.success(onRelay))
    link.answers([Self.lan.id: true, Self.paired.id: false])
    link.scriptOver(Self.lan.id, .success(onLAN))
    let supervisor = ConnectionSupervisor(link: link, clock: clock, random: { 0 })
    var events = EventReader(supervisor)
    await supervisor.start()
    #expect(await events.status() == .connecting)
    #expect(await events.status() == .connected)
    guard case .session(let first)? = await events.next() else { Issue.record("no session"); return }
    #expect(first === onRelay)

    await clock.waitForSleepers(1)
    await clock.advance(by: 60)
    guard case .sessionLost? = await events.next(), case .session(let second)? = await events.next() else {
      Issue.record("no switch")
      return
    }
    #expect(second === onLAN)
    #expect(onRelay.isClosed)
    #expect(await supervisor.status == .connected)
    #expect(link.connectsOver == [Self.lan.id])
  }

  @Test func `a route that answers but will not connect rests, and the session stays`() async throws {
    let link = SwitchingLink(routes: [Self.relay, Self.lan])
    let onRelay = try FakeSession(route: Self.relay)
    link.script(.success(onRelay))
    link.answers([Self.lan.id: true])
    link.scriptOver(Self.lan.id, .failure(.credentialRejected))
    let supervisor = ConnectionSupervisor(link: link, clock: clock, random: { 0 })
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await clock.waitForSleepers(1)
    await clock.advance(by: 60)
    await eventually { link.connectsOver.count == 1 }
    #expect(!onRelay.isClosed)
    // Cooling down: the next minute does not try it again.
    await clock.advance(by: 60)
    await settle()
    #expect(link.connectsOver.count == 1)
    #expect(link.preflights.filter { $0 == Self.lan.id }.count == 1)
  }

  @Test func `a silent route is checked half as often, and a network change checks it at once`() async throws {
    let link = SwitchingLink(routes: [Self.relay, Self.lan])
    let onRelay = try FakeSession(route: Self.relay)
    link.script(.success(onRelay))
    link.answers([Self.lan.id: false])
    let supervisor = ConnectionSupervisor(link: link, clock: clock, random: { 0 })
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await clock.waitForSleepers(1)
    await clock.advance(by: 60)
    await eventually { link.preflights.count == 1 }
    // Backed off for 120 s: the next minute skips it.
    await clock.advance(by: 60)
    await settle()
    #expect(link.preflights.count == 1)
    // Back on the home network: checked at once, answers, and the session moves.
    let onLAN = try FakeSession(route: Self.lan)
    link.answers([Self.lan.id: true])
    link.scriptOver(Self.lan.id, .success(onLAN))
    await supervisor.wake(.networkChanged(online: true))
    await eventually { link.connectsOver.count == 1 }
    #expect(link.connectsOver == [Self.lan.id])
  }

  @Test func `a probe the socket ignores while the host answers replaces the socket early`() async throws {
    let link = SwitchingLink(routes: [Self.lan])
    let session = try FakeSession(route: Self.lan)
    session.script(probes: [.hang])
    link.script(.success(session))
    link.answers([Self.lan.id: true])
    let supervisor = ConnectionSupervisor(link: link, clock: clock, random: { 0 })
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    _ = await events.next()
    await supervisor.wake(.foreground)
    await settle()
    // Well before the 15 s foreground timeout: 0.5 s, then the host answers over HTTP.
    await clock.advance(by: 0.5)
    await eventually { session.isClosed }
    #expect(session.isClosed)
    guard case .sessionLost? = await events.next() else {
      Issue.record("socket kept")
      return
    }
  }
}

/// A scripted link with routes: `connect()` from the script, `connect(over:)` per route, and
/// preflight answers per route.
final class SwitchingLink: RouteSwitchingLink {
  private let base = FakeLink()
  private let state = Mutex<(routes: [EnvironmentRoute], answers: [String: Bool], over: [String: [Result<FakeSession, ConnectionError>]], connectsOver: [String], preflights: [String])>(([], [:], [:], [], []))

  init(routes: [EnvironmentRoute]) {
    state.withLock { $0.routes = routes }
  }

  var connectsOver: [String] { state.withLock { $0.connectsOver } }
  var preflights: [String] { state.withLock { $0.preflights } }

  func script(_ results: Result<FakeSession, ConnectionError>...) {
    for result in results { base.script(result) }
  }

  func answers(_ answers: [String: Bool]) { state.withLock { $0.answers = answers } }

  func scriptOver(_ id: String, _ result: Result<FakeSession, ConnectionError>) {
    state.withLock { $0.over[id, default: []].append(result) }
  }

  func connect() async throws(ConnectionError) -> any LiveSession { try await base.connect() }
  func credentialRenewalDate() async -> Date? { nil }
  func renewCredential() async throws(ConnectionError) {}

  func betterRoutes(than route: EnvironmentRoute) -> [EnvironmentRoute] {
    RouteSelection.better(than: route, in: state.withLock { $0.routes }, order: nil)
  }

  func preflight(_ route: EnvironmentRoute) async -> Bool {
    state.withLock { state in
      state.preflights.append(route.id)
      return state.answers[route.id] ?? false
    }
  }

  func connect(over route: EnvironmentRoute) async throws(ConnectionError) -> any LiveSession {
    let next = state.withLock { state -> Result<FakeSession, ConnectionError>? in
      state.connectsOver.append(route.id)
      return state.over[route.id]?.isEmpty == false ? state.over[route.id]!.removeFirst() : nil
    }
    guard let next else { throw .timedOut }
    return try next.get()
  }
}
