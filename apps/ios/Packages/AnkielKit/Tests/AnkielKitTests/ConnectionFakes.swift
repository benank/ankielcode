import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// A clock that only moves when the test advances it. Sleepers whose deadline has passed return
/// at once, so it does not matter whether a sleeper registered before or after an advance.
final class TestClock: SupervisorClock {
  private struct Sleeper {
    let deadline: Date
    let continuation: CheckedContinuation<Void, any Error>
  }

  private let state: Mutex<(now: Date, sleepers: [UUID: Sleeper])>

  init(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
    state = Mutex((now, [:]))
  }

  var now: Date { state.withLock { $0.now } }
  var sleeperCount: Int { state.withLock { $0.sleepers.count } }

  /// Waits (bounded, by yielding) until at least `count` sleepers are registered, so an advance
  /// that follows reaches them.
  func waitForSleepers(_ count: Int) async {
    await eventually { self.sleeperCount >= count }
  }

  func sleep(until deadline: Date) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let immediate: Result<Void, any Error>? = state.withLock { state in
          if Task.isCancelled { return .failure(CancellationError()) }
          if deadline <= state.now { return .success(()) }
          state.sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
          return nil
        }
        if let immediate { continuation.resume(with: immediate) }
      }
    } onCancel: {
      state.withLock { $0.sleepers.removeValue(forKey: id) }?.continuation.resume(throwing: CancellationError())
    }
  }

  func advance(by seconds: TimeInterval) async {
    let due = state.withLock { state in
      state.now = state.now.addingTimeInterval(seconds)
      let now = state.now
      let due = state.sleepers.filter { $0.value.deadline <= now }
      for id in due.keys { state.sleepers.removeValue(forKey: id) }
      return due.values.map(\.continuation)
    }
    for continuation in due { continuation.resume() }
    await settle()
  }
}

/// Lets tasks woken by the test run before it looks at the result. Bounded yields, no sleeps.
func settle() async {
  for _ in 0..<50 { await Task.yield() }
}

/// Yields until `condition` holds (bounded; the caller's expectation reports a miss).
func eventually(_ condition: () -> Bool) async {
  for _ in 0..<20_000 where !condition() { await Task.yield() }
}

final class FakeSession: LiveSession {
  enum Probe { case answer, hang, fail }

  let initialConfig: ServerConfig
  let route: EnvironmentRoute
  private let state = Mutex<(ended: String?, waiters: [CheckedContinuation<String, Never>], probes: [Probe], probeCount: Int, closed: Bool)>((nil, [], [], 0, false))
  let shell = Mutex<(streams: [[ShellStreamItem]], subscriptions: [ShellSubscription], http: ShellHTTPSnapshot?, httpLoads: Int)>(([], [], nil, 0))
  /// Unary calls: scripted replies by tag, and what was sent.
  let calls = Mutex<(replies: [String: String], sent: [(tag: String, payload: String)])>(([:], []))
  let scopesValue = Mutex<Set<String>?>(nil)

  init(environmentId: String = "env-1", serverVersion: String = "1.0.0") throws {
    initialConfig = try decode(
      ServerConfig.self,
      json: #"{"environment":{"environmentId":"\#(environmentId)","label":"Test","serverVersion":"\#(serverVersion)","orchestrationProtocolVersion":2,"capabilities":{}},"shellThreadFamilies":true,"shellOlderSettled":true}"#)
    route = EnvironmentRoute(endpoint: EnvironmentEndpoint(httpBaseURL: URL(string: "https://example.com/")!)!)
  }

  var isClosed: Bool { state.withLock { $0.closed } }
  var probeCount: Int { state.withLock { $0.probeCount } }

  func script(probes: [Probe]) {
    state.withLock { $0.probes = probes }
  }

  func probe() async throws {
    let next = state.withLock { state -> Probe in
      state.probeCount += 1
      return state.probes.isEmpty ? .answer : state.probes.removeFirst()
    }
    switch next {
    case .answer: return
    case .fail: throw RpcError.connectionClosed("probe failed")
    case .hang: try await Task.sleep(for: .seconds(3600))
    }
  }

  func ended() async -> String {
    await withCheckedContinuation { continuation in
      let reason = state.withLock { state -> String? in
        if state.ended == nil { state.waiters.append(continuation) }
        return state.ended
      }
      if let reason { continuation.resume(returning: reason) }
    }
  }

  func end(_ reason: String = "socket closed") {
    let waiters = state.withLock { state -> [CheckedContinuation<String, Never>] in
      guard state.ended == nil else { return [] }
      state.ended = reason
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume(returning: reason) }
  }

  func subscribeShell(_ subscription: ShellSubscription) async throws -> RpcStream<ShellStreamItem> {
    let items = shell.withLock { shell -> [ShellStreamItem]? in
      shell.subscriptions.append(subscription)
      return shell.streams.isEmpty ? nil : shell.streams.removeFirst()
    }
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: ShellStreamItem.self)
    for item in items ?? [] { continuation.yield(item) }
    // A scripted stream stays open (like a live one); an unscripted one ends at once.
    if items == nil { continuation.finish(throwing: RpcError.interrupted) }
    return RpcStream(base: stream, stop: { continuation.finish() })
  }

  /// Thread streams: scripted item lists, one per subscription, and what was subscribed.
  let threads = Mutex<(streams: [[ThreadStreamItem]], subscriptions: [ThreadSubscription], stops: Int)>(([], [], 0))

  func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem> {
    let items = threads.withLock { threads -> [ThreadStreamItem]? in
      threads.subscriptions.append(subscription)
      return threads.streams.isEmpty ? nil : threads.streams.removeFirst()
    }
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: ThreadStreamItem.self)
    for item in items ?? [] { continuation.yield(item) }
    if items == nil { continuation.finish(throwing: RpcError.interrupted) }
    return RpcStream(base: stream, stop: { [self] in
      self.threads.withLock { $0.stops += 1 }
      continuation.finish()
    })
  }

  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as _: Response.Type
  ) async throws -> Response {
    let sent = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
    let reply = calls.withLock { calls -> String? in
      calls.sent.append((tag, sent))
      return calls.replies[tag]
    }
    guard let reply else {
      throw RpcError.failed(RpcFailure(error: .object(["_tag": .string("Unscripted"), "message": .string("no reply")])))
    }
    return try JSONDecoder().decode(Response.self, from: Data(reply.utf8))
  }

  func grantedScopes() async throws -> Set<String>? { scopesValue.withLock { $0 } }

  func loadShellSnapshot(_: ShellSubscription) async throws -> ShellHTTPSnapshot {
    let http = shell.withLock { shell in
      shell.httpLoads += 1
      return shell.http
    }
    guard let http else { throw ConnectionError.unreachable("no HTTP snapshot scripted") }
    return http
  }

  func close() async {
    state.withLock { $0.closed = true }
    end("closed by client")
  }
}

/// A scripted link: each `connect()` takes the next result, or waits (until cancelled) when the
/// script is empty.
final class FakeLink: EnvironmentLink {
  private let state = Mutex<(connects: [Result<FakeSession, ConnectionError>], connectCount: Int, renewalDate: Date?, renewals: [ConnectionError?], renewCount: Int)>(([], 0, nil, [], 0))

  var connectCount: Int { state.withLock { $0.connectCount } }
  var renewCount: Int { state.withLock { $0.renewCount } }

  func script(_ results: Result<FakeSession, ConnectionError>...) {
    state.withLock { $0.connects += results }
  }

  func setRenewal(_ date: Date?, results: [ConnectionError?] = []) {
    state.withLock {
      $0.renewalDate = date
      $0.renewals = results
    }
  }

  func connect() async throws(ConnectionError) -> any LiveSession {
    let next = state.withLock { state -> Result<FakeSession, ConnectionError>? in
      state.connectCount += 1
      return state.connects.isEmpty ? nil : state.connects.removeFirst()
    }
    guard let next else {
      try? await Task.sleep(for: .seconds(3600))
      throw .timedOut
    }
    return try next.get()
  }

  func credentialRenewalDate() async -> Date? {
    state.withLock { $0.renewalDate }
  }

  func renewCredential() async throws(ConnectionError) {
    let failure = state.withLock { state -> ConnectionError? in
      state.renewCount += 1
      let result = state.renewals.isEmpty ? nil : state.renewals.removeFirst()
      // A successful renewal moves the next due date an hour out.
      if result == nil, let date = state.renewalDate { state.renewalDate = date.addingTimeInterval(3600) }
      return result
    }
    if let failure { throw failure }
  }
}

/// Reads supervisor events in order.
struct EventReader {
  var iterator: AsyncStream<ConnectionSupervisor.Event>.Iterator

  init(_ supervisor: ConnectionSupervisor) {
    iterator = supervisor.events.makeAsyncIterator()
  }

  /// The next status, skipping session events.
  mutating func status() async -> ConnectionStatus? {
    while let event = await iterator.next(isolation: #isolation) {
      if case .status(let status) = event { return status }
    }
    return nil
  }

  mutating func next() async -> ConnectionSupervisor.Event? {
    await iterator.next(isolation: #isolation)
  }
}
