/// The shell reducer, ported from `packages/client-runtime/src/state/shellReducer.ts`.
public enum ShellReducer {
  /// Applies an incoming snapshot. Authoritative (`resolvedRoots == nil`): replace everything but
  /// keep a held repository identity the server has not resolved yet for the same root.
  /// Enrichment: only project identities change; threads and the cursor stay.
  public static func merge(
    _ previous: ShellSnapshot?, with next: ShellSnapshot, resolvedRepositoryIdentityRoots resolvedRoots: [String]?
  ) -> ShellSnapshot {
    guard let previous else { return next }
    guard let resolvedRoots else {
      let previousById = Dictionary(previous.projects.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
      var merged = next
      merged.projects = next.projects.map { retainRepositoryIdentity(previousById[$0.id], $0) }
      return merged
    }
    let resolved = Set(resolvedRoots)
    let nextById = Dictionary(next.projects.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    var enriched = previous
    enriched.projects = previous.projects.map { project in
      guard let candidate = nextById[project.id], candidate.workspaceRoot == project.workspaceRoot else {
        return project
      }
      var updated = project
      if resolved.contains(project.workspaceRoot) {
        updated.repositoryIdentity = candidate.repositoryIdentity
      } else if project.repositoryIdentity == nil, candidate.repositoryIdentity != nil {
        updated.repositoryIdentity = candidate.repositoryIdentity
      }
      return updated
    }
    return enriched
  }

  /// For an HTTP snapshot whose rows arrive without their deferred pull request links: a row
  /// with `pullRequests` absent keeps the links it had.
  public static func reuseDeferredLinks(_ previous: ShellSnapshot?, in next: ShellSnapshot) -> ShellSnapshot {
    guard let previous, !previous.threads.isEmpty else { return next }
    let previousById = Dictionary(previous.threads.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    var result = next
    for index in result.threads.indices where result.threads[index].pullRequests == nil {
      if let links = previousById[result.threads[index].id]?.pullRequests {
        result.threads[index].pullRequests = links
      }
    }
    return result
  }

  /// Applies sequenced deltas in order. Deltas at or below the cursor are ignored; sequences may
  /// skip. New rows append; the UI decides order.
  public static func apply(_ deltas: some Sequence<ShellDelta>, to snapshot: ShellSnapshot) -> ShellSnapshot {
    var next = snapshot
    for delta in deltas {
      apply(delta, to: &next)
    }
    return next
  }

  public static func apply(_ delta: ShellDelta, to snapshot: inout ShellSnapshot) {
    guard delta.sequence > snapshot.snapshotSequence else { return }
    switch delta {
    case .projectUpdated(_, let project):
      let index = snapshot.projects.firstIndex { $0.id == project.id }
      let retained = retainRepositoryIdentity(index.map { snapshot.projects[$0] }, project)
      if let index { snapshot.projects[index] = retained } else { snapshot.projects.append(retained) }
    case .projectRemoved(_, let projectId):
      snapshot.projects.removeAll { $0.id == projectId }
    case .threadUpdated(_, let location, let thread):
      guard location.known != nil else { return }  // An unknown location is not ours to apply.
      if location == .active {
        if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
          if snapshot.threads[index] != thread { snapshot.threads[index] = thread }
        } else {
          snapshot.threads.append(thread)
        }
      } else {
        // The archive has its own query; archive-located deltas only remove rows here.
        snapshot.threads.removeAll { $0.id == thread.id }
      }
      snapshot.archivedThreads.removeAll { $0.id == thread.id }
    case .threadRemoved(_, _, let threadId):
      snapshot.threads.removeAll { $0.id == threadId }
      snapshot.archivedThreads.removeAll { $0.id == threadId }
    }
    snapshot.snapshotSequence = delta.sequence
  }

  /// Enrichment is async: a project mutation can land with a null identity after a snapshot
  /// resolved it. Keep the held identity while the workspace root is unchanged.
  static func retainRepositoryIdentity(_ previous: ProjectShell?, _ next: ProjectShell) -> ProjectShell {
    guard next.repositoryIdentity == nil, let previous, let identity = previous.repositoryIdentity,
      previous.workspaceRoot == next.workspaceRoot
    else { return next }
    var retained = next
    retained.repositoryIdentity = identity
    return retained
  }
}

/// The client's view of the shell stream: rows plus sync status. A pure value; feed it items.
public struct ShellState: Sendable, Hashable {
  public enum Status: Sendable, Hashable {
    /// No rows yet.
    case empty
    /// Rows shown, still catching up to the completion marker.
    case synchronizing
    /// Caught up and receiving live deltas.
    case live
  }

  public private(set) var snapshot: ShellSnapshot?
  public private(set) var status: Status = .empty
  /// The server could not replay a resume: load the HTTP snapshot, then resubscribe.
  public private(set) var needsSnapshotReload = false
  /// Items that were ignored because they did not decode.
  public private(set) var undecodableItems = 0
  private var awaitingCompletion: Bool

  /// `awaitingCompletion` is true when the subscription asked for `requestCompletionMarker`.
  public init(awaitingCompletion: Bool = true, snapshot: ShellSnapshot? = nil) {
    self.awaitingCompletion = awaitingCompletion
    self.snapshot = snapshot
    status = snapshot == nil ? .empty : .synchronizing
  }

  public var projects: [ProjectShell] { snapshot?.projects ?? [] }
  public var threads: [ThreadShell] { snapshot?.threads ?? [] }
  public var sequence: Int? { snapshot?.snapshotSequence }

  public mutating func apply(_ items: some Sequence<ShellStreamItem>) {
    var deltas: [ShellDelta] = []
    func flush() {
      guard !deltas.isEmpty, let current = snapshot else {
        deltas = []
        return
      }
      snapshot = ShellReducer.apply(deltas, to: current)
      status = awaitingCompletion ? .synchronizing : .live
      deltas = []
    }
    for item in items {
      switch item {
      case .delta(let delta):
        deltas.append(delta)
      case .synchronized:
        flush()
        awaitingCompletion = false
        if snapshot != nil { status = .live }
      case .snapshot(let next, let roots):
        flush()
        snapshot = ShellReducer.merge(snapshot, with: next, resolvedRepositoryIdentityRoots: roots)
        status = awaitingCompletion ? .synchronizing : .live
      case .snapshotRequired:
        needsSnapshotReload = true
      case .undecodable:
        undecodableItems += 1
      case .unknown:
        break
      }
    }
    flush()
  }

  public mutating func apply(_ item: ShellStreamItem) {
    apply(CollectionOfOne(item))
  }

  /// A new subscription starts: held rows stay visible but are no longer live until it catches up.
  public mutating func beginSubscription(awaitingCompletion: Bool = true) {
    self.awaitingCompletion = awaitingCompletion
    needsSnapshotReload = false
    status = snapshot == nil ? .empty : (awaitingCompletion ? .synchronizing : .live)
  }

  /// The transport dropped: keep the rows, stop claiming they are live.
  public mutating func markStale() {
    awaitingCompletion = true
    if snapshot != nil { status = .synchronizing }
  }

  /// Applies an authoritative HTTP snapshot (§5.5). Ignored when it is older than the held rows,
  /// so a slow download never overwrites newer live data. Rows without their deferred pull
  /// request links keep the ones they had. Returns whether it was applied.
  @discardableResult
  public mutating func replace(with next: ShellSnapshot) -> Bool {
    needsSnapshotReload = false
    if let held = snapshot, next.snapshotSequence < held.snapshotSequence { return false }
    snapshot = ShellReducer.merge(
      snapshot, with: ShellReducer.reuseDeferredLinks(snapshot, in: next), resolvedRepositoryIdentityRoots: nil)
    status = awaitingCompletion ? .synchronizing : .live
    return true
  }
}
