import Foundation

/// The review and git reads, over any caller (a live session, or the probe's bare client).
public enum ReviewCalls {
  /// One turn's patch (`fromTurnCount = turn - 1`), as review shows it.
  public static func turnDiff(threadId: String, turn: Int, via caller: some UnaryCaller) async throws -> ThreadTurnDiff {
    try await caller.call(
      TurnDiffRequest.rpcTag, payload: TurnDiffRequest(threadId: threadId, fromTurnCount: max(0, turn - 1), toTurnCount: turn),
      as: ThreadTurnDiff.self)
  }

  /// A git comparison. The first read lists tracked files only (fast); when the server says the
  /// result is incomplete, `partial` sees it and a second read with its completion token adds the
  /// untracked files (RN `diffPreview`). Older servers answer complete at once.
  public static func preview(
    cwd: String, kind: ReviewGitKind, via caller: some UnaryCaller,
    partial: @Sendable (DiffPreviewResult) async -> Void = { _ in }
  ) async throws -> DiffPreviewResult {
    let tracked = try await caller.call(
      DiffPreviewRequest.rpcTag, payload: DiffPreviewRequest(cwd: cwd, sourceKind: kind, trackedOnly: true),
      as: DiffPreviewResult.self)
    guard tracked.incomplete else { return tracked }
    await partial(tracked)
    let request =
      tracked.completionToken.map { DiffPreviewRequest(cwd: cwd, sourceKind: kind, completionToken: $0) }
      ?? DiffPreviewRequest(cwd: cwd, sourceKind: kind)
    return try await caller.call(DiffPreviewRequest.rpcTag, payload: request, as: DiffPreviewResult.self)
  }

  /// One file's patch of a comparison whose patches were left out (a truncated source).
  public static func filePatch(
    cwd: String, source: DiffPreviewSource, file: DiffPreviewSource.FileStat, via caller: some UnaryCaller
  ) async throws -> DiffPreviewSource? {
    guard let kind = source.gitKind else { return nil }
    let request = DiffPreviewRequest(
      cwd: cwd, sourceKind: nil, baseRef: source.baseRef, mergeBase: source.mergeBase,
      file: .init(path: file.path, previousPath: file.previousPath, sourceKind: kind, changeType: file.changeType))
    let result = try await caller.call(DiffPreviewRequest.rpcTag, payload: request, as: DiffPreviewResult.self)
    return result.sources.first { $0.kind == kind.rawValue }
  }

  /// Both sides of a file in a git comparison, for showing unchanged lines.
  public static func fileContents(
    cwd: String, source: DiffPreviewSource, file: DiffFile, via caller: some UnaryCaller
  ) async throws -> DiffFileContents? {
    guard let kind = source.gitKind else { return nil }
    let request = DiffFileContentsRequest(
      cwd: cwd, sourceKind: kind, changeType: file.changeType, baseRef: source.baseRef, headRef: source.headRef,
      oldPath: file.previousPath ?? file.path, newPath: file.path)
    return try await caller.call(DiffFileContentsRequest.rpcTag, payload: request, as: DiffFileContents.self)
  }

  public static func status(cwd: String, via caller: some UnaryCaller) async throws -> VcsStatus {
    try await caller.call(VcsRefreshStatusRequest.rpcTag, payload: VcsRefreshStatusRequest(cwd: cwd), as: VcsStatus.self)
  }

  public static func pull(cwd: String, via caller: some UnaryCaller) async throws -> VcsPullResult {
    try await caller.call(VcsPullRequest.rpcTag, payload: VcsPullRequest(cwd: cwd), as: VcsPullResult.self)
  }

  /// Local branch names (`vcs.listRefs`, remotes left out), for naming a feature branch.
  public static func localBranches(cwd: String, via caller: some UnaryCaller) async throws -> [String] {
    let result = try await caller.call(ListRefsRequest.rpcTag, payload: ListRefsRequest(cwd: cwd), as: ListRefsResult.self)
    return result.refs.filter { $0.isRemote != true }.map(\.name)
  }

  /// `vcs.createRef` with `switchRef`: the new branch's name.
  public static func createBranch(cwd: String, name: String, via caller: some UnaryCaller) async throws -> String {
    try await caller.call(CreateRefRequest.rpcTag, payload: CreateRefRequest(cwd: cwd, refName: name), as: CreateRefResult.self).refName
  }
}

/// `vcs.listRefs`.
public struct ListRefsRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "vcs.listRefs"
  public var cwd: String
  public var limit = 100
  public var refresh = true
  public init(cwd: String) { self.cwd = cwd }
}

struct ListRefsResult: Decodable, Sendable {
  struct Ref: Decodable, Sendable {
    var name: String
    var isRemote: Bool?
  }
  var refs: [Ref]

  enum CodingKeys: String, CodingKey { case refs }

  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    refs = c.loose(LossyArray<Ref>.self, .refs)?.elements ?? []
  }
}

/// `vcs.createRef`.
public struct CreateRefRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "vcs.createRef"
  public var cwd: String
  public var refName: String
  public var switchRef = true
  public init(cwd: String, refName: String) {
    self.cwd = cwd
    self.refName = refName
  }
}

struct CreateRefResult: Decodable, Sendable {
  var refName: String
}

extension EnvironmentRegistry {
  /// A unary review or git read on an environment's session.
  public func reviewCall<Result: Sendable>(
    _ environmentId: String, _ body: (any UnaryCaller) async throws -> Result
  ) async throws(EnvironmentRequestError) -> Result {
    try await request(environmentId) { try await body(SessionCaller(session: $0)) }
  }

  /// A git action's progress (`git.runStackedAction`).
  public func gitActionStream(
    _ request: GitStackedActionRequest, in environmentId: String
  ) async throws(EnvironmentRequestError) -> RpcStream<GitActionProgress> {
    try await self.request(environmentId) { session in
      try await session.stream(GitStackedActionRequest.rpcTag, payload: request, of: GitActionProgress.self)
    }
  }
}
