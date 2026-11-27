/// `OrchestrationV2ShellSnapshot`. Rows that do not decode are skipped and counted, so one
/// malformed row never blanks the list.
public struct ShellSnapshot: Sendable, Hashable, Codable {
  public var schemaVersion: Int
  public var snapshotSequence: Int
  public var threads: [ThreadShell]
  public var archivedThreads: [ThreadShell]
  public var projects: [ProjectShell]
  public var olderSettled: OlderSettled?
  /// Rows skipped while decoding (not on the wire).
  public var droppedRows: DroppedRows

  public struct OlderSettled: Sendable, Hashable, Codable {
    public var before: WireTimestamp
    public var asOfSequence: Int
    public var counts: [Count]

    public struct Count: Sendable, Hashable, Codable {
      public var projectId: String
      public var count: Int
    }
  }

  public struct DroppedRows: Sendable, Hashable, Codable {
    public var count = 0
    public var firstReason: String?
  }

  public init(
    schemaVersion: Int = 1, snapshotSequence: Int = 0, threads: [ThreadShell] = [],
    archivedThreads: [ThreadShell] = [], projects: [ProjectShell] = [], olderSettled: OlderSettled? = nil
  ) {
    self.schemaVersion = schemaVersion
    self.snapshotSequence = snapshotSequence
    self.threads = threads
    self.archivedThreads = archivedThreads
    self.projects = projects
    self.olderSettled = olderSettled
    droppedRows = DroppedRows()
  }

  enum CodingKeys: String, CodingKey {
    case schemaVersion, snapshotSequence, threads, archivedThreads, projects, olderSettled
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
    snapshotSequence = try c.decode(Int.self, forKey: .snapshotSequence)
    let threads = try c.decodeIfPresent(LossyArray<ThreadShell>.self, forKey: .threads) ?? LossyArray([])
    let archived =
      try c.decodeIfPresent(LossyArray<ThreadShell>.self, forKey: .archivedThreads) ?? LossyArray([])
    let projects = try c.decodeIfPresent(LossyArray<ProjectShell>.self, forKey: .projects) ?? LossyArray([])
    self.threads = threads.elements
    archivedThreads = archived.elements
    self.projects = projects.elements
    olderSettled = try? c.decodeIfPresent(OlderSettled.self, forKey: .olderSettled)
    droppedRows = DroppedRows(
      count: threads.droppedCount + archived.droppedCount + projects.droppedCount,
      firstReason: threads.firstDropReason ?? archived.firstDropReason ?? projects.firstDropReason)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schemaVersion, forKey: .schemaVersion)
    try c.encode(snapshotSequence, forKey: .snapshotSequence)
    try c.encode(threads, forKey: .threads)
    try c.encode(archivedThreads, forKey: .archivedThreads)
    try c.encode(projects, forKey: .projects)
    try c.encodeIfPresent(olderSettled, forKey: .olderSettled)
  }
}

public enum ShellLocation: String, Sendable { case active, archive }

/// One item of `orchestration.subscribeShell`.
public enum ShellStreamItem: Sendable, Hashable, Decodable {
  case synchronized
  /// Load the HTTP snapshot and subscribe again from its cursor.
  case snapshotRequired
  /// Authoritative when `resolvedRepositoryIdentityRoots` is nil; otherwise an enrichment that
  /// only updates project identities.
  case snapshot(ShellSnapshot, resolvedRepositoryIdentityRoots: [String]?)
  case delta(ShellDelta)
  /// A kind this client does not know. Ignored; it never advances the cursor.
  case unknown(kind: String)
  /// A known kind whose body did not decode. Ignored and reported.
  case undecodable(kind: String, reason: String)

  enum CodingKeys: String, CodingKey {
    case kind, snapshot, resolvedRepositoryIdentityRoots
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try c.decode(String.self, forKey: .kind)
    do {
      switch kind {
      case "synchronized":
        self = .synchronized
      case "snapshot-required":
        self = .snapshotRequired
      case "snapshot":
        self = .snapshot(
          try c.decode(ShellSnapshot.self, forKey: .snapshot),
          resolvedRepositoryIdentityRoots: try c.decodeIfPresent(
            [String].self, forKey: .resolvedRepositoryIdentityRoots))
      case "project.updated", "project.removed", "thread.updated", "thread.removed":
        self = .delta(try ShellDelta(from: decoder))
      default:
        self = .unknown(kind: kind)
      }
    } catch {
      self = .undecodable(kind: kind, reason: describeDecodingError(error))
    }
  }
}

/// A sequenced shell change.
public enum ShellDelta: Sendable, Hashable, Decodable {
  case projectUpdated(sequence: Int, project: ProjectShell)
  case projectRemoved(sequence: Int, projectId: String)
  case threadUpdated(sequence: Int, location: WireEnum<ShellLocation>, thread: ThreadShell)
  case threadRemoved(sequence: Int, location: WireEnum<ShellLocation>, threadId: String)

  public var sequence: Int {
    switch self {
    case .projectUpdated(let sequence, _), .projectRemoved(let sequence, _),
      .threadUpdated(let sequence, _, _), .threadRemoved(let sequence, _, _):
      sequence
    }
  }

  enum CodingKeys: String, CodingKey { case kind, sequence, project, projectId, location, thread, threadId }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let sequence = try c.decode(Int.self, forKey: .sequence)
    switch try c.decode(String.self, forKey: .kind) {
    case "project.updated":
      self = .projectUpdated(sequence: sequence, project: try c.decode(ProjectShell.self, forKey: .project))
    case "project.removed":
      self = .projectRemoved(sequence: sequence, projectId: try c.decode(String.self, forKey: .projectId))
    case "thread.updated":
      self = .threadUpdated(
        sequence: sequence, location: try c.decode(WireEnum<ShellLocation>.self, forKey: .location),
        thread: try c.decode(ThreadShell.self, forKey: .thread))
    case "thread.removed":
      self = .threadRemoved(
        sequence: sequence, location: try c.decode(WireEnum<ShellLocation>.self, forKey: .location),
        threadId: try c.decode(String.self, forKey: .threadId))
    case let kind:
      throw DecodingError.dataCorrupted(
        .init(codingPath: c.codingPath, debugDescription: "Not a shell delta: \(kind)"))
    }
  }
}

/// `OrchestrationV2SubscribeShellInput`.
public struct ShellSubscription: Sendable, Hashable, Encodable {
  public var afterSequence: Int?
  public var httpSnapshotFallback: Bool?
  public var knownProjectIdentities: String?
  public var requestCompletionMarker: Bool?
  public var omitIdleSubagents: Bool?
  public var omitOlderSettled: Bool?

  public init(
    afterSequence: Int? = nil, requestCompletionMarker: Bool = true, omitIdleSubagents: Bool? = nil,
    omitOlderSettled: Bool? = nil
  ) {
    self.afterSequence = afterSequence
    self.requestCompletionMarker = requestCompletionMarker
    self.omitIdleSubagents = omitIdleSubagents
    self.omitOlderSettled = omitOlderSettled
  }

  public static let rpcTag = "orchestration.subscribeShell"
}
