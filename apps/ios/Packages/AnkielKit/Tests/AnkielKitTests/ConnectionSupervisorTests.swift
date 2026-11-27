import Foundation
import Testing

@testable import AnkielKit

@Suite struct ConnectionSupervisorTests {
  let clock = TestClock()
  let link = FakeLink()

  /// `random` 0 picks the low end of the jitter window, so delays are exact.
  func supervisor(random: Double = 0) -> ConnectionSupervisor {
    ConnectionSupervisor(link: link, clock: clock, random: { random })
  }

  @Test func `first attempt is connecting, then connected with a session`() async throws {
    let session = try FakeSession()
    link.script(.success(session))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    #expect(await events.status() == .connecting)
    #expect(await events.status() == .connected)
    guard case .session(let live)? = await events.next() else { Issue.record("no session"); return }
    #expect(live === session)
  }

  @Test func `transient failures back off with capped exponential jittered delays`() async throws {
    link.script(.failure(.unreachable("refused")), .failure(.unreachable("refused")), .success(try FakeSession()))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    let start = clock.now
    await supervisor.start()
    #expect(await events.status() == .connecting)
    // First failure: ceiling 2 s, low end of the window 1 s.
    guard case .reconnecting(1, let retryAt?, let failure?)? = await events.status() else {
      Issue.record("expected backoff")
      return
    }
    #expect(retryAt == start.addingTimeInterval(1))
    #expect(failure.cause == .unreachable)
    await clock.advance(by: 0.9)
    #expect(link.connectCount == 1)
    await clock.advance(by: 0.1)
    #expect(await events.status() == .reconnecting(attempt: 2, retryAt: nil, lastFailure: failure))
    // Second failure: ceiling 4 s, 2 s.
    guard case .reconnecting(2, let second?, _)? = await events.status() else {
      Issue.record("expected second backoff")
      return
    }
    #expect(second == clock.now.addingTimeInterval(2))
    await clock.advance(by: 2)
    #expect(await events.status() == .reconnecting(attempt: 3, retryAt: nil, lastFailure: failure))
    #expect(await events.status() == .connected)
  }

  @Test func `backoff delay is jittered within the upper half of a capped ceiling`() async {
    let low = ConnectionSupervisor(link: link, clock: clock, random: { 0 })
    let high = ConnectionSupervisor(link: link, clock: clock, random: { 1 })
    #expect(await low.retryDelay(failureCount: 0) == 1)
    #expect(await high.retryDelay(failureCount: 0) == 2)
    #expect(await low.retryDelay(failureCount: 3) == 8)
    #expect(await high.retryDelay(failureCount: 30) == 300)
  }

  @Test func `backoff resets only after the connection stayed up`() async throws {
    let flapping = try FakeSession()
    let stable = try FakeSession()
    link.script(
      .failure(.unreachable("a")), .failure(.unreachable("b")), .success(flapping),
      .success(stable), .success(try FakeSession()))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()  // connecting
    _ = await events.status()  // backoff 1 s
    await clock.advance(by: 1)
    _ = await events.status()  // attempt 2
    _ = await events.status()  // backoff 2 s
    await clock.advance(by: 2)
    _ = await events.status()  // attempt 3
    #expect(await events.status() == .connected)

    // Up for 5 s, then dropped: still two failures deep, so the next delay is 4 s, not 0.25 s.
    await clock.advance(by: 5)
    flapping.end()
    guard case .reconnecting(0, let retryAt?, _)? = await events.status() else {
      Issue.record("expected backoff after a flapping session")
      return
    }
    #expect(retryAt == clock.now.addingTimeInterval(4))
    await clock.advance(by: 4)
    _ = await events.status()  // attempt
    #expect(await events.status() == .connected)

    // Up for 30 s: the count resets and a drop reconnects almost at once.
    await clock.advance(by: 30)
    stable.end()
    guard case .reconnecting(0, let quick?, let failure?)? = await events.status() else {
      Issue.record("expected a quick retry")
      return
    }
    #expect(quick == clock.now.addingTimeInterval(0.25))
    #expect(failure.cause == .sessionEnded)
  }

  @Test func `a rejected credential waits for an explicit wakeup`() async throws {
    link.script(.failure(.credentialRejected), .success(try FakeSession()))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    guard case .needsPairing(let failure)? = await events.status() else {
      Issue.record("expected needsPairing")
      return
    }
    #expect(failure.cause == .credentialRejected)
    await clock.advance(by: 3600)
    #expect(link.connectCount == 1)
    await supervisor.wake(.retry)
    #expect(await events.status() == .reconnecting(attempt: 2, retryAt: nil, lastFailure: failure))
    #expect(await events.status() == .connected)
  }

  @Test func `incompatible and wrong-machine failures block with their own status`() async {
    link.script(.failure(.incompatibleProtocol(serverVersion: 1)))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    #expect(await events.status() == .incompatible(ConnectionFailure(.serverTooOld(serverProtocol: 1))))

    let other = ConnectionSupervisor(link: FakeLinkFailing(.environmentMismatch(expected: "a", found: "b")), clock: clock)
    var otherEvents = EventReader(other)
    await other.start()
    _ = await otherEvents.status()
    #expect(await otherEvents.status() == .failed(ConnectionFailure(.environmentMismatch(found: "b"))))
  }

  @Test func `offline waits for the network instead of a timer`() async throws {
    link.script(.failure(.unreachable("no route")), .success(try FakeSession()))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start(networkOnline: false)
    _ = await events.status()
    #expect(await events.status() == .offline)
    await clock.advance(by: 600)
    #expect(link.connectCount == 1)
    await supervisor.wake(.networkChanged(online: true))
    _ = await events.status()
    #expect(await events.status() == .connected)
  }

  @Test func `a wakeup probes a live session instead of reconnecting`() async throws {
    let session = try FakeSession()
    link.script(.success(session))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await supervisor.wake(.foreground)
    await eventually { session.probeCount == 1 }
    await eventually { clock.sleeperCount == 1 }  // the stable timer only: the probe finished
    await supervisor.wake(.networkChanged(online: true))
    await eventually { session.probeCount == 2 }
    #expect(session.probeCount == 2)
    #expect(link.connectCount == 1)
    #expect(!session.isClosed)
    #expect(await supervisor.status == .connected)
  }

  @Test func `a failed probe replaces the socket`() async throws {
    let session = try FakeSession()
    session.script(probes: [.hang])
    let replacement = try FakeSession()
    link.script(.success(session), .success(replacement))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    _ = await events.next()  // session
    await supervisor.wake(.retry)
    await eventually { session.probeCount == 1 }
    await clock.advance(by: 2.9)
    #expect(!session.isClosed)
    await clock.advance(by: 0.1)  // the quick probe's 3 s deadline
    guard case .sessionLost? = await events.next() else { Issue.record("expected session loss"); return }
    guard case .status(.reconnecting(0, _, let failure?))? = await events.next() else {
      Issue.record("expected reconnecting")
      return
    }
    #expect(failure.cause == .timedOut)
    #expect(session.isClosed)
    await clock.advance(by: 0.25)
    _ = await events.status()
    #expect(await events.status() == .connected)
    guard case .session(let next)? = await events.next() else { Issue.record("no new session"); return }
    #expect(next === replacement)
  }

  @Test func `a foreground probe tolerates one miss`() async throws {
    let session = try FakeSession()
    session.script(probes: [.hang, .answer])
    link.script(.success(session))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await supervisor.wake(.foreground)
    await eventually { session.probeCount == 1 }
    await clock.waitForSleepers(2)  // stable timer and the probe deadline
    await clock.advance(by: 15)
    await eventually { session.probeCount == 2 }
    await settle()
    #expect(session.probeCount == 2)
    #expect(!session.isClosed)
    #expect(link.connectCount == 1)
  }

  @Test func `the token renews in place without touching the socket`() async throws {
    let session = try FakeSession()
    link.script(.success(session))
    link.setRenewal(clock.now.addingTimeInterval(100), results: [.unreachable("blip"), nil])
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await clock.waitForSleepers(2)  // stable timer and renewal
    await clock.advance(by: 99)
    #expect(link.renewCount == 0)
    await clock.advance(by: 1)
    await eventually { link.renewCount == 1 }
    #expect(link.renewCount == 1)  // transient failure: retried after 5 s
    await clock.waitForSleepers(2)
    await clock.advance(by: 5)
    await eventually { link.renewCount == 2 }
    #expect(link.renewCount == 2)
    #expect(!session.isClosed)
    #expect(await supervisor.status == .connected)
  }

  @Test func `a rejected renewal ends the renewal loop and leaves the socket up`() async throws {
    let session = try FakeSession()
    link.script(.success(session))
    link.setRenewal(clock.now.addingTimeInterval(10), results: [.credentialRejected])
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    await clock.waitForSleepers(2)
    await clock.advance(by: 10)
    await eventually { link.renewCount == 1 }
    await clock.advance(by: 60)
    await settle()
    #expect(link.renewCount == 1)
    #expect(!session.isClosed)
    #expect(await supervisor.status == .connected)
  }

  @Test func `an attempt that hangs times out as a transient failure`() async throws {
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    await clock.advance(by: 30)
    guard case .reconnecting(1, _, let failure?)? = await events.status() else {
      Issue.record("expected a timeout backoff")
      return
    }
    #expect(failure.cause == .timedOut)
  }

  @Test func `stop closes the session and ends the events`() async throws {
    let session = try FakeSession()
    link.script(.success(session))
    let supervisor = supervisor()
    var events = EventReader(supervisor)
    await supervisor.start()
    _ = await events.status()
    _ = await events.status()
    _ = await events.next()
    await supervisor.stop()
    guard case .sessionLost? = await events.next() else { Issue.record("expected loss"); return }
    #expect(await events.next() == nil)
    await settle()
    #expect(session.isClosed)
  }
}

/// Always fails with one error.
struct FakeLinkFailing: EnvironmentLink {
  let error: ConnectionError
  init(_ error: ConnectionError) { self.error = error }
  func connect() async throws(ConnectionError) -> any LiveSession { throw error }
  func credentialRenewalDate() async -> Date? { nil }
  func renewCredential() async throws(ConnectionError) {}
}
