import Foundation
import Testing

@testable import AnkielKit

@Suite struct ShellSyncTests {
  let clock = TestClock()

  func snapshot(_ sequence: Int, _ threads: [ThreadShell]) -> ShellSnapshot {
    ShellSnapshot(snapshotSequence: sequence, threads: threads)
  }

  func sync(cache: ShellCache? = nil) -> ShellSync {
    ShellSync(environmentId: "env-1", cache: cache, clock: clock)
  }

  /// Waits until `sync` reports `count` subscriptions on `session`.
  func subscriptions(_ session: FakeSession, count: Int) async -> [ShellSubscription] {
    for _ in 0..<200 {
      let seen = session.shell.withLock { $0.subscriptions }
      if seen.count >= count { return seen }
      await Task.yield()
    }
    return session.shell.withLock { $0.subscriptions }
  }

  @Test func `a reconnect resumes from the last applied sequence`() async throws {
    let first = try FakeSession()
    first.shell.withLock { $0.streams = [[.snapshot(snapshot(10, [try! Fixture.thread("t1")]), resolvedRepositoryIdentityRoots: nil), .synchronized]] }
    let sync = sync()
    await sync.attach(first)
    let cold = await subscriptions(first, count: 1)
    #expect(cold[0].afterSequence == nil)
    #expect(cold[0].omitIdleSubagents == true)
    await settle()
    #expect(await sync.state.status == .live)

    await sync.detach()
    #expect(await sync.state.status == .synchronizing)  // rows stay, no longer live
    #expect(await sync.state.threads.count == 1)

    let second = try FakeSession()
    second.shell.withLock { $0.streams = [[.synchronized]] }
    await sync.attach(second)
    let resumed = await subscriptions(second, count: 1)
    #expect(resumed[0].afterSequence == 10)
    #expect(resumed[0].httpSnapshotFallback == true)
  }

  @Test func `a different server build subscribes cold but keeps the rows visible`() async throws {
    let first = try FakeSession(serverVersion: "1.0.0")
    first.shell.withLock { $0.streams = [[.snapshot(snapshot(10, [try! Fixture.thread("t1")]), resolvedRepositoryIdentityRoots: nil)]] }
    let sync = sync()
    await sync.attach(first)
    _ = await subscriptions(first, count: 1)
    await settle()
    await sync.detach()

    let upgraded = try FakeSession(serverVersion: "2.0.0")
    upgraded.shell.withLock { $0.streams = [[]] }
    await sync.attach(upgraded)
    let next = await subscriptions(upgraded, count: 1)
    #expect(next[0].afterSequence == nil)
    #expect(await sync.state.threads.count == 1)
  }

  @Test func `snapshot-required loads the HTTP snapshot and resubscribes from its cursor`() async throws {
    let first = try FakeSession()
    first.shell.withLock { $0.streams = [[.snapshot(snapshot(10, [try! Fixture.thread("t1")]), resolvedRepositoryIdentityRoots: nil), .synchronized]] }
    let sync = sync()
    await sync.attach(first)
    _ = await subscriptions(first, count: 1)
    await settle()
    await sync.detach()

    let second = try FakeSession()
    second.shell.withLock {
      $0.streams = [[.snapshotRequired], [.synchronized]]
      $0.http = ShellHTTPSnapshot(
        snapshot: snapshot(50, [try! Fixture.thread("t1"), try! Fixture.thread("t2")]), projectIdentities: "ids-1")
    }
    await sync.attach(second)
    let seen = await subscriptions(second, count: 2)
    #expect(seen[0].afterSequence == 10)
    #expect(seen[0].httpSnapshotFallback == true)
    #expect(seen[1].afterSequence == 50)
    #expect(seen[1].knownProjectIdentities == "ids-1")
    #expect(seen[1].httpSnapshotFallback == nil)
    await settle()
    #expect(await sync.state.threads.count == 2)
    #expect(await sync.state.status == .live)
  }

  @Test func `an HTTP snapshot older than the held rows is ignored`() throws {
    var state = ShellState(awaitingCompletion: false, snapshot: snapshot(20, [try Fixture.thread("t1")]))
    let applied = state.replace(with: snapshot(5, []))
    #expect(!applied)
    #expect(state.threads.count == 1)
    #expect(state.sequence == 20)
  }

  @Test func `a stream failure on a live socket resubscribes after a delay`() async throws {
    let session = try FakeSession()
    // No scripted streams: each subscription fails with an interrupt.
    let sync = sync()
    await sync.attach(session)
    #expect(await subscriptions(session, count: 1).count == 1)
    await clock.advance(by: 1)
    #expect(await subscriptions(session, count: 2).count == 2)
    await clock.advance(by: 2)
    #expect(await subscriptions(session, count: 3).count == 3)
  }

  @Test func `the cache round-trips rows and restores them as not live`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "shell-cache-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = ShellCache(directory: directory)
    let session = try FakeSession()
    let rows = [try Fixture.thread("t1"), try Fixture.thread("t2")]
    var withProject = snapshot(7, rows)
    withProject.projects = [try Fixture.project]
    let entry = ShellCacheEntry(savedAt: clock.now, source: ShellSource(session.initialConfig), snapshot: withProject)
    await cache.save(entry, for: "env-1")

    let loaded = try #require(await cache.load("env-1"))
    #expect(loaded.snapshot.threads == rows)
    #expect(loaded.snapshot.projects == withProject.projects)

    let sync = sync(cache: cache)
    await sync.restore()
    #expect(await sync.state.threads == rows)
    #expect(await sync.state.status == .synchronizing)
    #expect(await sync.subscription(for: session.initialConfig).afterSequence == 7)
  }

  @Test func `an unreadable cache is discarded`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "shell-cache-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = ShellCache(directory: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("{not json".utf8).write(to: cache.url("env-1"))
    #expect(await cache.load("env-1") == nil)
    #expect(!FileManager.default.fileExists(atPath: cache.url("env-1").path()))
  }

  @Test func `rows older than 12 hours subscribe cold`() async throws {
    let session = try FakeSession()
    let sync = sync()
    session.shell.withLock { $0.streams = [[.snapshot(snapshot(3, []), resolvedRepositoryIdentityRoots: nil)]] }
    await sync.attach(session)
    _ = await subscriptions(session, count: 1)
    await settle()
    await clock.advance(by: 13 * 3600)
    #expect(await sync.subscription(for: session.initialConfig).afterSequence == nil)
  }
}

@Suite struct RouteSelectionTests {
  func endpoint(_ url: String) -> EnvironmentEndpoint {
    EnvironmentEndpoint(httpBaseURL: URL(string: url)!)!
  }

  func reported(_ kind: String, _ url: String) throws -> ServerConfig.DirectEndpoint {
    try decode(ServerConfig.DirectEndpoint.self, json: #"{"kind":"\#(kind)","httpBaseUrl":"\#(url)"}"#)
  }

  @Test func `route kinds come from the address`() {
    #expect(ConnectionRouteKind(endpoint: endpoint("https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/")) == .relay)
    #expect(ConnectionRouteKind(endpoint: endpoint("https://abcdefghijklmnopqrstuvwxyz.relay.example.com/")) == .relay)
    #expect(ConnectionRouteKind(endpoint: endpoint("http://192.168.1.20:3773/")) == .lan)
    #expect(ConnectionRouteKind(endpoint: endpoint("http://127.0.0.1:3773/")) == .lan)
    #expect(ConnectionRouteKind(endpoint: endpoint("https://mac.tailnet.ts.net/")) == .tailnet)
    #expect(ConnectionRouteKind(endpoint: endpoint("http://100.101.1.2:3773/")) == .tailnet)
    #expect(ConnectionRouteKind(endpoint: endpoint("https://code.example.com/")) == .direct)
  }

  @Test func `learned routes skip loopback and never send a token in clear to a public host`() throws {
    let paired = [EnvironmentRoute(endpoint: endpoint("https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/"))]
    let learned = RouteSelection.learn(
      [
        try reported("lan", "http://192.168.1.20:3773"),
        try reported("lan", "http://127.0.0.1:3773"),
        try reported("relay", "http://public.example.com"),
        try reported("tailnet", "https://mac.tailnet.ts.net"),
        try reported("lan", "ftp://192.168.1.20"),
        try reported("lan", "http://192.168.1.20:3773/"),
      ], into: paired)
    #expect(learned.map(\.id) == [
      "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/",
      "http://192.168.1.20:3773/",
      "https://mac.tailnet.ts.net/",
    ])
    #expect(learned.dropFirst().allSatisfy { $0.learned })
  }

  @Test func `a plain-HTTP pairing may learn plain-HTTP routes`() throws {
    let paired = [EnvironmentRoute(endpoint: endpoint("http://code.example.com/"))]
    let learned = RouteSelection.learn([try reported("relay", "http://other.example.com")], into: paired)
    #expect(learned.count == 2)
  }

  @Test func `routes are tried last-used first, then LAN, then the paired route`() {
    let relay = EnvironmentRoute(endpoint: endpoint("https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/"))
    let lan = EnvironmentRoute(endpoint: endpoint("http://192.168.1.20:3773/"), learned: true)
    let tailnet = EnvironmentRoute(endpoint: endpoint("https://mac.tailnet.ts.net/"), learned: true)
    let routes = [relay, tailnet, lan]
    #expect(RouteSelection.order(routes, lastUsed: nil).map(\.id) == [lan.id, relay.id, tailnet.id])
    #expect(RouteSelection.order(routes, lastUsed: tailnet.id).map(\.id) == [tailnet.id, lan.id, relay.id])
  }
}
