import Foundation

/// What a cached or held shell was read under. A resume (`afterSequence`) is only valid for the
/// same server build, migration and omission flags (`state/shell.ts:96-160`).
public struct ShellSource: Sendable, Hashable, Codable {
  public var serverVersion: String
  public var databaseMigration: Int?
  public var omitIdleSubagents: Bool
  public var omitOlderSettled: Bool

  public init(_ config: ServerConfig) {
    let subscription = config.shellSubscription
    serverVersion = config.environment.serverVersion
    databaseMigration = config.environment.databaseMigration
    omitIdleSubagents = subscription.omitIdleSubagents == true
    omitOlderSettled = subscription.omitOlderSettled == true
  }
}

/// One environment's last shell on disk, so a cold launch shows the thread list at once.
public struct ShellCacheEntry: Sendable, Codable {
  public var savedAt: Date
  public var source: ShellSource
  public var snapshot: ShellSnapshot
}

/// Shell snapshots under one directory, one file per environment. Reads and writes run off the
/// caller's actor.
public struct ShellCache: Sendable {
  public let directory: URL

  public init(directory: URL) {
    self.directory = directory
  }

  func url(_ environmentId: String) -> URL {
    let safe = environmentId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-", "_"]))
    return directory.appending(path: "\(safe ?? environmentId).json")
  }

  /// nil when absent or unreadable (an unreadable cache is deleted rather than half-trusted).
  @concurrent public func load(_ environmentId: String) async -> ShellCacheEntry? {
    let url = url(environmentId)
    guard let data = try? Data(contentsOf: url) else { return nil }
    do {
      return try JSONDecoder().decode(ShellCacheEntry.self, from: data)
    } catch {
      try? FileManager.default.removeItem(at: url)
      return nil
    }
  }

  @concurrent public func save(_ entry: ShellCacheEntry, for environmentId: String) async {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try JSONEncoder().encode(entry).write(to: url(environmentId), options: .protectedAtomic)
    } catch {
      // A cache is an optimization; a failed write only costs the next cold launch.
    }
  }

  @concurrent public func remove(_ environmentId: String) async {
    try? FileManager.default.removeItem(at: url(environmentId))
  }
}

/// Keeps one environment's shell in sync across sessions: resumes from the last applied sequence,
/// loads the HTTP snapshot after `snapshot-required`, resubscribes when the stream fails on a
/// healthy socket (without touching the connection status), and saves the rows to disk.
/// Reducing happens here, off the main actor; `states` carries the latest value to the UI.
public actor ShellSync {
  /// The latest shell state; older values are dropped if the reader falls behind.
  public nonisolated let states: AsyncStream<ShellState>
  public private(set) var state = ShellState()
  /// The last subscription sent (diagnostics).
  public private(set) var lastSubscription: ShellSubscription?

  private let environmentId: String
  private let cache: ShellCache?
  private let clock: any SupervisorClock
  private let sink: AsyncStream<ShellState>.Continuation
  /// Where the held rows came from and when they were last fresh.
  private var source: ShellSource?
  private var freshAt: Date?
  private var follow: Task<Void, Never>?
  private var pendingSave: Task<Void, Never>?
  /// Writes run one after another so an older snapshot never lands after a newer one.
  private var lastWrite: Task<Void, Never>?
  static let resumeWindow: TimeInterval = 12 * 3600

  public init(environmentId: String, cache: ShellCache?, clock: any SupervisorClock = SystemSupervisorClock()) {
    self.environmentId = environmentId
    self.cache = cache
    self.clock = clock
    (states, sink) = AsyncStream.makeStream(of: ShellState.self, bufferingPolicy: .bufferingNewest(1))
  }

  /// Shows the cached rows (marked not live) when nothing newer is held.
  public func restore() async {
    guard state.snapshot == nil, let entry = await cache?.load(environmentId), state.snapshot == nil else { return }
    state = ShellState(awaitingCompletion: true, snapshot: entry.snapshot)
    source = entry.source
    freshAt = entry.savedAt
    sink.yield(state)
  }

  /// Follows a new session; the previous one's stream (if any) is dropped.
  public func attach(_ session: any LiveSession) {
    follow?.cancel()
    follow = Task { await self.run(session) }
  }

  /// The session is gone: keep the rows, mark them not live, save them.
  public func detach() {
    follow?.cancel()
    follow = nil
    state.markStale()
    sink.yield(state)
    saveNow()
  }

  /// Stops and deletes the cached rows (the environment was removed).
  public func clear() async {
    follow?.cancel()
    follow = nil
    pendingSave?.cancel()
    pendingSave = nil
    state = ShellState()
    source = nil
    sink.yield(state)
    sink.finish()
    // An in-flight write would recreate the file after the delete.
    await lastWrite?.value
    await cache?.remove(environmentId)
  }

  /// The subscription for a session: resume from the held cursor when the rows came from the same
  /// server build and flags and are less than 12 h old; otherwise cold (held rows stay visible
  /// until the snapshot replaces them).
  func subscription(for config: ServerConfig) -> ShellSubscription {
    var subscription = config.shellSubscription
    if let snapshot = state.snapshot, source == ShellSource(config), let freshAt,
      clock.now.timeIntervalSince(freshAt) < Self.resumeWindow
    {
      subscription.afterSequence = snapshot.snapshotSequence
      subscription.httpSnapshotFallback = true
    }
    return subscription
  }

  private func run(_ session: any LiveSession) async {
    let config = session.initialConfig
    var resumeAfterHTTP: (sequence: Int, identities: String?)?
    var forceCold = false
    var retryDelay: TimeInterval = 1
    while !Task.isCancelled {
      var subscription = forceCold ? config.shellSubscription : self.subscription(for: config)
      if let resume = resumeAfterHTTP {
        subscription.afterSequence = resume.sequence
        subscription.knownProjectIdentities = resume.identities
        subscription.httpSnapshotFallback = nil
      }
      resumeAfterHTTP = nil
      forceCold = false
      lastSubscription = subscription
      state.beginSubscription(awaitingCompletion: subscription.requestCompletionMarker == true)
      sink.yield(state)
      do {
        for try await item in try await session.subscribeShell(subscription) {
          state.apply(item)
          if state.needsSnapshotReload { break }
          source = ShellSource(config)
          freshAt = clock.now
          retryDelay = 1
          sink.yield(state)
          scheduleSave()
        }
        if Task.isCancelled { return }
        if state.needsSnapshotReload {
          do {
            let http = try await session.loadShellSnapshot(config.shellSubscription)
            state.replace(with: http.snapshot)
            source = ShellSource(config)
            freshAt = clock.now
            sink.yield(state)
            scheduleSave()
            resumeAfterHTTP = (state.sequence ?? http.snapshot.snapshotSequence, http.projectIdentities)
          } catch {
            forceCold = true
          }
          continue
        }
      } catch {
        // The supervisor owns a dead socket; only a stream failure on a live one resubscribes.
        if case RpcError.connectionClosed = error { return }
        if case RpcError.protocolDefect = error { return }
      }
      if Task.isCancelled { return }
      do { try await clock.sleep(for: retryDelay) } catch { return }
      retryDelay = min(retryDelay * 2, 30)
    }
  }

  private func scheduleSave() {
    guard cache != nil, pendingSave == nil else { return }
    let clock = clock
    pendingSave = Task {
      do { try await clock.sleep(for: 1) } catch { return }
      self.saveNow()
    }
  }

  private func saveNow() {
    pendingSave?.cancel()
    pendingSave = nil
    guard let cache, let snapshot = state.snapshot, let source else { return }
    let entry = ShellCacheEntry(savedAt: freshAt ?? clock.now, source: source, snapshot: snapshot)
    let environmentId = environmentId
    let previous = lastWrite
    lastWrite = Task {
      await previous?.value
      await cache.save(entry, for: environmentId)
    }
  }
}
