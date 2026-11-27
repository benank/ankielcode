import Foundation

/// What one turn changed: the thread folder's checkpoint plus its tracked repositories (RN
/// `deriveThreadCheckpointSummaries` and `deriveTurnRepositoryChanges`).
public struct TurnChange: Sendable, Hashable, Identifiable {
  public var turnCount: Int
  public var runId: String
  public var checkpointId: String
  /// `ready`, `missing`, `error` or `stale`.
  public var status: String
  /// The thread folder's own files (a prefix when `filesTotal` is set).
  public var files: [Checkpoint.File]
  public var filesTotal: Checkpoint.Totals?
  public var repositories: [Repository]

  public struct Repository: Sendable, Hashable {
    public var name: String
    public var files: [Checkpoint.File]
    public var filesTotal: Checkpoint.Totals?
    /// Changed, but nothing was recorded before the turn to compare with.
    public var baselineMissing: Bool
  }

  public init(
    turnCount: Int, runId: String, checkpointId: String, status: String, files: [Checkpoint.File],
    filesTotal: Checkpoint.Totals? = nil, repositories: [Repository] = []
  ) {
    self.turnCount = turnCount
    self.runId = runId
    self.checkpointId = checkpointId
    self.status = status
    self.files = files
    self.filesTotal = filesTotal
    self.repositories = repositories
  }

  public var id: String { ReviewSectionID.turn(turnCount).rawValue }

  public var totals: Checkpoint.Totals {
    var count = 0
    var additions = 0
    var deletions = 0
    for list in [(files, filesTotal)] + repositories.map({ ($0.files, $0.filesTotal) }) {
      let total = list.1 ?? Checkpoint.Totals(
        count: list.0.count, additions: list.0.reduce(0) { $0 + $1.additions }, deletions: list.0.reduce(0) { $0 + $1.deletions })
      count += total.count
      additions += total.additions
      deletions += total.deletions
    }
    return Checkpoint.Totals(count: count, additions: additions, deletions: deletions)
  }

  public var hasChanges: Bool { !files.isEmpty || !repositories.isEmpty }

  /// Turns review lists, newest first (`getReadyReviewCheckpoints`).
  public static func derive(_ projection: ThreadProjection) -> [TurnChange] {
    guard !projection.checkpoints.isEmpty else { return [] }
    let scopes = Dictionary(projection.checkpointScopes.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let repositoriesByRun = repositoryChanges(projection, scopes: scopes)
    var byTurn: [Int: TurnChange] = [:]
    for checkpoint in projection.checkpoints {
      guard let turn = checkpoint.appRunOrdinal, let runId = checkpoint.runId else { continue }
      if scopes[checkpoint.scopeId]?.repositoryPath != nil { continue }
      let change = TurnChange(
        turnCount: turn, runId: runId, checkpointId: checkpoint.id, status: checkpoint.status, files: checkpoint.files,
        filesTotal: checkpoint.filesTotal, repositories: repositoriesByRun[runId] ?? [])
      guard change.status == "ready" || change.hasChanges else { continue }
      byTurn[turn] = change
    }
    return byTurn.values.sorted { $0.turnCount > $1.turnCount }
  }

  private static func repositoryChanges(
    _ projection: ThreadProjection, scopes: [String: CheckpointScope]
  ) -> [String: [Repository]] {
    guard scopes.values.contains(where: { $0.repositoryPath != nil }) else { return [:] }
    let withoutBaseline = Set(projection.checkpoints.filter { $0.status == "missing" }.map { "\($0.scopeId)\u{0}\($0.ordinalWithinScope + 1)" })
    var byRun: [String: [Repository]] = [:]
    for checkpoint in projection.checkpoints {
      guard let runId = checkpoint.runId, checkpoint.status == "ready", let scope = scopes[checkpoint.scopeId],
        let repositoryPath = scope.repositoryPath
      else { continue }
      let baselineMissing = checkpoint.files.isEmpty && withoutBaseline.contains("\(checkpoint.scopeId)\u{0}\(checkpoint.ordinalWithinScope)")
      if checkpoint.files.isEmpty, !baselineMissing { continue }
      let name = scope.label ?? repositoryPath.split(separator: "/").last.map(String.init) ?? repositoryPath
      byRun[runId, default: []].append(
        Repository(name: name, files: checkpoint.files, filesTotal: checkpoint.filesTotal, baselineMissing: baselineMissing))
    }
    return byRun.mapValues { $0.sorted { $0.name < $1.name } }
  }
}

/// A review section's id, as RN writes it (`turn:3`, `git:working-tree`, `git:branch-range`).
public enum ReviewSectionID: Hashable, Sendable {
  case turn(Int)
  case git(ReviewGitKind)

  public init?(rawValue: String) {
    if rawValue.hasPrefix("turn:"), let count = Int(rawValue.dropFirst(5)) {
      self = .turn(count)
    } else if rawValue.hasPrefix("git:"), let kind = ReviewGitKind(rawValue: String(rawValue.dropFirst(4))) {
      self = .git(kind)
    } else {
      return nil
    }
  }

  public var rawValue: String {
    switch self {
    case .turn(let count): "turn:\(count)"
    case .git(let kind): "git:\(kind.rawValue)"
    }
  }
}

/// One entry of review's section menu.
public struct ReviewSection: Sendable, Hashable, Identifiable {
  public var id: ReviewSectionID
  public var turn: TurnChange?
  /// The git comparison, once read.
  public var source: DiffPreviewSource?
  /// A git section still loading, or failed, shows with no source.
  public var state: State

  public enum State: Sendable, Hashable { case ready, loading, failed }

  /// RN `buildReviewSectionItems`: turns (newest first), then Uncommitted, then Changes.
  public static func build(
    turns: [TurnChange], sources: [ReviewGitKind: DiffPreviewSource], states: [ReviewGitKind: State]
  ) -> [ReviewSection] {
    var sections = turns.map { ReviewSection(id: .turn($0.turnCount), turn: $0, source: nil, state: .ready) }
    for kind in [ReviewGitKind.workingTree, .branchRange] {
      if let source = sources[kind] {
        sections.append(ReviewSection(id: .git(kind), turn: nil, source: source, state: .ready))
      } else if let state = states[kind], state != .ready {
        sections.append(ReviewSection(id: .git(kind), turn: nil, source: nil, state: state))
      }
    }
    return sections
  }

  /// The stored pick while it exists, else Changes, else the first section
  /// (`resolveReviewSelectedSectionId`): a pick made before its section loads comes back.
  public static func resolve(_ sections: [ReviewSection], picked: ReviewSectionID?) -> ReviewSectionID? {
    if let picked, sections.contains(where: { $0.id == picked }) { return picked }
    return sections.first { $0.id == .git(.branchRange) }?.id ?? sections.first?.id
  }
}
