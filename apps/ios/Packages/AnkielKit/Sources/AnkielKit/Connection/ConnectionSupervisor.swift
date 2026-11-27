import Foundation
import os

/// The single owner of retries for one environment (ported from
/// `packages/client-runtime/src/connection/supervisor.ts`, much smaller).
///
/// - Transient failures back off with jittered, capped exponential delays; the failure count resets
///   only after a connection stays up for `stableAfter`.
/// - Blocking failures (credential rejected, incompatible, wrong machine, clock skew) and offline
///   wait for a wakeup instead of a timer.
/// - Wakeups on a live session probe it (`server.probe`); only a failed probe replaces the socket.
/// - A DPoP token renews in place on the live session before it expires; a failed renewal never
///   closes a healthy socket.
/// - On a route other than the preferred one, better routes are checked every minute and when the
///   network changes; one that answers is connected first and then replaces the session, so moving
///   between a relay and the LAN never drops the computer (RN `checkBetterRoutes`).
/// - A probe the socket leaves unanswered asks the host over HTTP; when the host answers but the
///   socket stays silent, the socket is dead and is replaced without waiting out the timeout.
public actor ConnectionSupervisor {
  public struct Options: Sendable {
    public var establishTimeout: TimeInterval = 30
    public var probeTimeout: TimeInterval = 15
    public var quickProbeTimeout: TimeInterval = 3
    public var stableAfter: TimeInterval = 30
    public var sessionLossRetryDelay: TimeInterval = 0.25
    public var renewalRetryDelay: TimeInterval = 5
    public var baseRetryDelay: TimeInterval = 1
    public var maxRetryDelay: TimeInterval = 300
    public var betterRouteInterval: TimeInterval = 60
    /// A better route that answered but then failed to connect rests this long, so a flaky LAN
    /// cannot bounce the connection.
    public var betterRouteCooldown: TimeInterval = 300
    /// A route that keeps not answering is checked half as often each time, up to this.
    public var silentRouteBackoffMax: TimeInterval = 1800
    public var silentSocketCheckAfter: TimeInterval = 0.5
    /// Off the LAN one lost packet can stall a healthy socket for a second.
    public var remoteSilentSocketAfter: TimeInterval = 2.5

    public init() {}
  }

  public enum Event: Sendable {
    case status(ConnectionStatus)
    /// A new ready session; the previous one (if any) is gone.
    case session(any LiveSession)
    case sessionLost
  }

  private enum Phase {
    case idle, connecting, backoff, blocked, offline, stopped
    case connected(any LiveSession, since: Date)
  }

  /// Every status change and session handoff, in order. Finishes on `stop()`.
  public nonisolated let events: AsyncStream<Event>
  public private(set) var status = ConnectionStatus.connecting

  private let link: any EnvironmentLink
  private let clock: any SupervisorClock
  private let random: @Sendable () -> Double
  private let options: Options
  private let sink: AsyncStream<Event>.Continuation

  private var phase = Phase.idle
  /// Bumped whenever the current operation changes, so late results from an old one are dropped.
  private var generation = 0
  /// Attempts since the last live session.
  private var attempt = 0
  /// Consecutive transient failures; drives the backoff.
  private var failures = 0
  private var lastFailure: ConnectionFailure?
  private var networkOnline = true
  private var work: Task<Void, Never>?
  private var sessionTasks: [Task<Void, Never>] = []
  private var probe: Task<Void, Never>?
  private var hasPublished = false
  private var routeCooldowns: [String: Date] = [:]
  private var silentRoutes: [String: (failures: Int, until: Date)] = [:]
  private var checkingRoutes = false
  private static let log = Logger(subsystem: "com.ankiel.code", category: "supervisor")

  public init(
    link: any EnvironmentLink,
    clock: any SupervisorClock = SystemSupervisorClock(),
    random: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
    options: Options = Options()
  ) {
    self.link = link
    self.clock = clock
    self.random = random
    self.options = options
    (events, sink) = AsyncStream.makeStream(of: Event.self)
  }

  /// Starts connecting. The first attempt runs even when the OS reports offline (that report is
  /// often wrong for loopback and LAN hosts); a failure while offline then waits for the network.
  public func start(networkOnline: Bool = true) {
    guard case .idle = phase else { return }
    self.networkOnline = networkOnline
    beginAttempt()
  }

  public func wake(_ reason: ConnectionWakeup) {
    Self.log.info("wake \(String(describing: reason), privacy: .public) in \(String(describing: self.status), privacy: .public)")
    if case .networkChanged(let online) = reason { networkOnline = online }
    switch phase {
    case .idle, .stopped, .connecting:
      return
    case .connected(let session, _):
      startProbe(reason)
      if case .networkChanged(online: true) = reason {
        // A new network can make a skipped route reachable again.
        silentRoutes = [:]
        let generation = generation
        Task { await self.checkBetterRoutes(generation, session) }
      }
    case .backoff, .blocked, .offline:
      if case .networkChanged(online: false) = reason {
        if case .backoff = phase { enterOffline() }
        return
      }
      if reason.resetsBackoff { failures = 0 }
      beginAttempt()
    }
  }

  /// Closes the session and stops for good (the environment was removed).
  public func stop() {
    if case .connected(let session, _) = phase {
      Task { await session.close() }
      sink.yield(.sessionLost)
    }
    phase = .stopped
    generation += 1
    cancelWork()
    sink.finish()
  }

  /// Drops the live session as if the socket died (debug and live tests).
  public func dropSession() {
    loseSession(ConnectionFailure(.sessionEnded, detail: "Dropped by the client."), immediate: true)
  }

  // MARK: - Attempts

  private func beginAttempt() {
    cancelWork()
    generation += 1
    attempt += 1
    phase = .connecting
    publish(
      attempt == 1 && lastFailure == nil
        ? .connecting : .reconnecting(attempt: attempt, retryAt: nil, lastFailure: lastFailure))
    let generation = generation
    let link = link
    let clock = clock
    let deadline = clock.now.addingTimeInterval(options.establishTimeout)
    work = Task {
      let result: Result<any LiveSession, ConnectionError>
      do {
        result = .success(try await clock.withDeadline(deadline) { try await link.connect() })
      } catch let error as ConnectionError {
        result = .failure(error)
      } catch is TimeoutError {
        result = .failure(.timedOut)
      } catch {
        return  // Cancelled: a newer operation owns the state.
      }
      self.attemptFinished(generation, result)
    }
  }

  private func attemptFinished(_ generation: Int, _ result: Result<any LiveSession, ConnectionError>) {
    guard generation == self.generation, case .connecting = phase else {
      if case .success(let session) = result { Task { await session.close() } }
      return
    }
    work = nil
    switch result {
    case .success(let session):
      connected(session)
    case .failure(let error):
      let failure = ConnectionFailure(error)
      lastFailure = failure
      if failure.isBlocking {
        phase = .blocked
        publish(Self.blockedStatus(failure))
      } else if !networkOnline {
        enterOffline()
      } else {
        let delay = retryDelay(failureCount: failures)
        failures += 1
        scheduleRetry(after: delay)
      }
    }
  }

  private func scheduleRetry(after delay: TimeInterval) {
    cancelWork()
    generation += 1
    phase = .backoff
    let retryAt = clock.now.addingTimeInterval(delay)
    publish(.reconnecting(attempt: attempt, retryAt: retryAt, lastFailure: lastFailure))
    let generation = generation
    let clock = clock
    work = Task {
      do { try await clock.sleep(until: retryAt) } catch { return }
      self.retryElapsed(generation)
    }
  }

  private func retryElapsed(_ generation: Int) {
    guard generation == self.generation, case .backoff = phase else { return }
    beginAttempt()
  }

  private func enterOffline() {
    cancelWork()
    generation += 1
    phase = .offline
    publish(.offline)
  }

  /// `ceiling = min(max, base × 2^(failures+1))`, delay uniformly in `[ceiling/2, ceiling]`.
  func retryDelay(failureCount: Int) -> TimeInterval {
    let ceiling = min(options.maxRetryDelay, options.baseRetryDelay * pow(2, Double(min(failureCount, 20) + 1)))
    return ceiling / 2 + ceiling / 2 * random()
  }

  // MARK: - Live session

  private func connected(_ session: any LiveSession) {
    generation += 1
    let since = clock.now
    phase = .connected(session, since: since)
    attempt = 0
    lastFailure = nil
    publish(.connected)
    sink.yield(.session(session))

    let generation = generation
    let clock = clock
    let link = link
    let options = options
    sessionTasks = [
      Task {
        let reason = await session.ended()
        self.sessionEnded(generation, reason)
      },
      Task {
        do { try await clock.sleep(until: since.addingTimeInterval(options.stableAfter)) } catch { return }
        self.markStable(generation)
      },
      Task { await Self.renewInPlace(link: link, clock: clock, retryDelay: options.renewalRetryDelay) },
    ]
    if link is any RouteSwitchingLink {
      sessionTasks.append(
        Task {
          while !Task.isCancelled {
            do { try await clock.sleep(for: options.betterRouteInterval) } catch { return }
            await self.checkBetterRoutes(generation, session)
          }
        })
    }
  }

  // MARK: - Better routes

  /// Checks better routes now (an address was added or the order changed).
  public func recheckRoutes() {
    guard case .connected(let session, _) = phase else { return }
    routeCooldowns = [:]
    silentRoutes = [:]
    let generation = generation
    Task { await self.checkBetterRoutes(generation, session) }
  }

  /// Checks the routes preferred over the session's, and moves to the best one that answers.
  func checkBetterRoutes(_ generation: Int, _ session: any LiveSession) async {
    guard let link = link as? any RouteSwitchingLink, generation == self.generation, case .connected = phase, !checkingRoutes
    else { return }
    let now = clock.now
    let candidates = link.betterRoutes(than: session.route).filter {
      (routeCooldowns[$0.id] ?? .distantPast) <= now && (silentRoutes[$0.id]?.until ?? .distantPast) <= now
    }
    guard !candidates.isEmpty else { return }
    checkingRoutes = true
    defer { checkingRoutes = false }
    let clock = clock
    let timeout = options.quickProbeTimeout
    let answered = await withTaskGroup(of: (String, Bool).self) { group in
      for route in candidates {
        group.addTask {
          let ok = (try? await clock.withTimeout(timeout) { await link.preflight(route) }) ?? false
          return (route.id, ok)
        }
      }
      var answered: [String: Bool] = [:]
      for await (id, ok) in group { answered[id] = ok }
      return answered
    }
    for route in candidates {
      if answered[route.id] == true {
        silentRoutes[route.id] = nil
      } else {
        let failures = (silentRoutes[route.id]?.failures ?? 0) + 1
        let delay = min(options.silentRouteBackoffMax, options.betterRouteInterval * pow(2, Double(failures)))
        silentRoutes[route.id] = (failures, now.addingTimeInterval(delay))
      }
    }
    guard generation == self.generation, case .connected = phase,
      let best = candidates.first(where: { answered[$0.id] == true })
    else { return }
    Self.log.info("better route answered: \(best.kind.rawValue, privacy: .public)")
    let next: any LiveSession
    do {
      next = try await clock.withTimeout(options.establishTimeout) { try await link.connect(over: best) }
    } catch {
      routeCooldowns[best.id] = clock.now.addingTimeInterval(options.betterRouteCooldown)
      return
    }
    guard generation == self.generation, case .connected(let old, _) = phase else {
      Task { await next.close() }
      return
    }
    // The new session is up before the old one goes, so the computer never shows as offline.
    cancelWork()
    Task { await old.close() }
    sink.yield(.sessionLost)
    connected(next)
  }

  private func markStable(_ generation: Int) {
    guard generation == self.generation, case .connected = phase else { return }
    failures = 0
  }

  private func sessionEnded(_ generation: Int, _ reason: String) {
    guard generation == self.generation else { return }
    loseSession(ConnectionFailure(.sessionEnded, detail: reason), immediate: false)
  }

  private func loseSession(_ failure: ConnectionFailure, immediate: Bool) {
    guard case .connected(let session, let since) = phase else { return }
    Self.log.info("session lost: \(String(describing: failure.cause), privacy: .public) \(failure.detail ?? "", privacy: .public)")
    cancelWork()
    Task { await session.close() }
    sink.yield(.sessionLost)
    if clock.now.timeIntervalSince(since) >= options.stableAfter { failures = 0 }
    lastFailure = failure
    attempt = 0
    phase = .backoff
    if !networkOnline && !immediate {
      enterOffline()
      return
    }
    // The first loss after a healthy session reconnects almost at once; a flapping one backs off.
    if immediate || failures == 0 {
      scheduleRetry(after: options.sessionLossRetryDelay)
    } else {
      let delay = retryDelay(failureCount: failures)
      failures += 1
      scheduleRetry(after: delay)
    }
  }

  private func startProbe(_ reason: ConnectionWakeup) {
    guard case .connected(let session, _) = phase, probe == nil else { return }
    let quick: Bool =
      switch reason {
      case .retry: true
      case .networkChanged(let online): !online || session.route.kind.answersQuickly
      case .foreground: false
      }
    let timeout = quick ? options.quickProbeTimeout : options.probeTimeout
    // A busy host can miss one foreground probe while the socket is healthy, so the first miss
    // asks again and only the second replaces the session.
    let tolerance = reason == .foreground ? 1 : 0
    let generation = generation
    let clock = clock
    let start = clock.now
    let switching = link as? any RouteSwitchingLink
    let silentAfter = session.route.kind.answersQuickly ? options.silentSocketCheckAfter : options.remoteSilentSocketAfter
    let checkAfter = options.silentSocketCheckAfter
    probe = Task {
      let answered = await withTaskGroup(of: Bool?.self) { group -> Bool? in
        group.addTask {
          var answered = false
          for round in 0...tolerance where !answered {
            let deadline = start.addingTimeInterval(timeout * Double(round + 1))
            answered = (try? await clock.withDeadline(deadline) { try await session.probe() }) != nil
            if Task.isCancelled { return nil }
          }
          return answered
        }
        if let switching {
          // The host answering a fresh request while the socket stays silent means the socket
          // is dead (RN silent-socket check).
          group.addTask {
            do { try await clock.sleep(until: start.addingTimeInterval(checkAfter)) } catch { return nil }
            let hostAnswered = (try? await clock.withTimeout(timeout) { await switching.preflight(session.route) }) ?? false
            guard hostAnswered else { return nil }
            do { try await clock.sleep(until: start.addingTimeInterval(silentAfter)) } catch { return nil }
            return false
          }
        }
        for await result in group {
          if let result {
            group.cancelAll()
            return result
          }
        }
        return Task.isCancelled ? nil : false
      }
      guard let answered, !Task.isCancelled else { return }
      self.probeFinished(generation, answered: answered)
    }
  }

  private func probeFinished(_ generation: Int, answered: Bool) {
    probe = nil
    Self.log.info("probe \(answered ? "answered" : "missed", privacy: .public)")
    guard generation == self.generation, case .connected = phase, !answered else { return }
    loseSession(ConnectionFailure(.timedOut, detail: "The host did not answer a health check."), immediate: true)
  }

  /// Sleeps until the token is due, renews, repeats. Transient failures retry every
  /// `retryDelay`; a rejection ends the loop and leaves the socket alone (the next connect reports
  /// it).
  private static func renewInPlace(
    link: any EnvironmentLink, clock: any SupervisorClock, retryDelay: TimeInterval
  ) async {
    while !Task.isCancelled {
      guard let due = await link.credentialRenewalDate() else { return }
      do { try await clock.sleep(until: due) } catch { return }
      do {
        try await link.renewCredential()
      } catch {
        if ConnectionFailure(error).isBlocking { return }
        do { try await clock.sleep(for: retryDelay) } catch { return }
      }
    }
  }

  // MARK: - Plumbing

  private func cancelWork() {
    work?.cancel()
    work = nil
    probe?.cancel()
    probe = nil
    for task in sessionTasks { task.cancel() }
    sessionTasks = []
  }

  private func publish(_ next: ConnectionStatus) {
    guard !hasPublished || next != status else { return }
    hasPublished = true
    status = next
    sink.yield(.status(next))
  }

  static func blockedStatus(_ failure: ConnectionFailure) -> ConnectionStatus {
    switch failure.cause {
    case .credentialRejected: .needsPairing(failure)
    case .serverTooOld, .serverTooNew: .incompatible(failure)
    default: .failed(failure)
    }
  }
}
