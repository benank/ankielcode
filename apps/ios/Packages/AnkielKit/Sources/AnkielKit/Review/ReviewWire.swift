import Foundation

// Wire shapes for diff review and the thread's git state (`packages/contracts/src/{checkpointDiff,
// review,git}.ts`). Requests encode exactly what the schemas accept: `Schema.optional` keys are
// left out when unset, required-nullable keys (`previousPath`, `baseRef`, `headRef`) send `null`.

// MARK: Turn diffs

/// `orchestration.getTurnDiff`: the patch between two turn counts (`from == to - 1` is one turn).
public struct TurnDiffRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "orchestration.getTurnDiff"
  public var threadId: String
  public var fromTurnCount: Int
  public var toTurnCount: Int
  public var ignoreWhitespace: Bool?

  public init(threadId: String, fromTurnCount: Int, toTurnCount: Int, ignoreWhitespace: Bool? = nil) {
    self.threadId = threadId
    self.fromTurnCount = fromTurnCount
    self.toTurnCount = toTurnCount
    self.ignoreWhitespace = ignoreWhitespace
  }
}

/// `orchestration.getFullThreadDiff`: everything the thread changed up to a turn.
public struct FullThreadDiffRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "orchestration.getFullThreadDiff"
  public var threadId: String
  public var toTurnCount: Int

  public init(threadId: String, toTurnCount: Int) {
    self.threadId = threadId
    self.toTurnCount = toTurnCount
  }
}

/// `ThreadTurnDiff`: the thread folder's own patch plus each tracked repository's.
public struct ThreadTurnDiff: Decodable, Sendable, Hashable {
  public var threadId: String
  public var fromTurnCount: Int
  public var toTurnCount: Int
  public var diff: String
  public var repositories: [Repository]

  public struct Repository: Decodable, Sendable, Hashable {
    public var name: String
    public var repositoryPath: String
    /// From the thread's folder, `/`-separated; may start with `../`.
    public var relativePath: String
    public var diff: String
  }

  public init(threadId: String, fromTurnCount: Int, toTurnCount: Int, diff: String, repositories: [Repository] = []) {
    self.threadId = threadId
    self.fromTurnCount = fromTurnCount
    self.toTurnCount = toTurnCount
    self.diff = diff
    self.repositories = repositories
  }

  enum CodingKeys: String, CodingKey { case threadId, fromTurnCount, toTurnCount, diff, repositories }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = c.loose(String.self, .threadId) ?? ""
    fromTurnCount = c.loose(Int.self, .fromTurnCount) ?? 0
    toTurnCount = c.loose(Int.self, .toTurnCount) ?? 0
    diff = c.loose(String.self, .diff) ?? ""
    repositories = c.loose(LossyArray<Repository>.self, .repositories)?.elements ?? []
  }

  /// One patch for review: each repository's paths are prefixed with its folder, so the same path
  /// in two repositories stays two files (RN `reviewTurnDiffText`).
  public var reviewText: String {
    let parts = [(diff, "")] + repositories.map { ($0.diff, $0.relativePath) }
    let nonEmpty = parts.filter { !$0.0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    if nonEmpty.allSatisfy({ $0.1.isEmpty || $0.1 == "." }) { return nonEmpty.map(\.0).joined(separator: "\n") }
    var truncated = false
    let patches = nonEmpty.map { text, folder -> String in
      var body = text
      if let range = Self.markerRange(body) {
        truncated = true
        body = String(body[..<range.lowerBound])
      }
      let patch = folder.isEmpty || folder == "." ? body : UnifiedDiff.prefixPaths(body, folder: folder)
      return patch.hasSuffix("\n") ? patch : patch + "\n"
    }
    return patches.joined() + (truncated ? "\n[truncated]" : "")
  }

  private static func markerRange(_ text: String) -> Range<String.Index>? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasSuffix("[truncated]") else { return nil }
    return text.range(of: "[truncated]", options: .backwards)
  }
}

// MARK: Git previews

/// `review.getDiffPreview`: the working tree or branch comparison of a checkout, or one file of it.
public struct DiffPreviewRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "review.getDiffPreview"
  public var cwd: String
  public var baseRef: String?
  public var mergeBase: String?
  public var sourceKind: ReviewGitKind?
  public var trackedOnly: Bool?
  public var completionToken: String?
  public var file: File?

  public struct File: Encodable, Sendable, Hashable {
    public var path: String
    public var previousPath: String?
    public var sourceKind: ReviewGitKind
    public var changeType: String?

    enum CodingKeys: String, CodingKey { case path, previousPath, sourceKind, changeType }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(path, forKey: .path)
      // Required and nullable.
      if let previousPath { try c.encode(previousPath, forKey: .previousPath) } else { try c.encodeNil(forKey: .previousPath) }
      try c.encode(sourceKind, forKey: .sourceKind)
      try c.encodeIfPresent(changeType, forKey: .changeType)
    }
  }

  public init(
    cwd: String, sourceKind: ReviewGitKind? = nil, baseRef: String? = nil, mergeBase: String? = nil,
    trackedOnly: Bool? = nil, completionToken: String? = nil, file: File? = nil
  ) {
    self.cwd = cwd
    self.sourceKind = sourceKind
    self.baseRef = baseRef
    self.mergeBase = mergeBase
    self.trackedOnly = trackedOnly
    self.completionToken = completionToken
    self.file = file
  }
}

/// The two git comparisons review offers (`ReviewDiffPreviewSourceKind` minus `commit`).
public enum ReviewGitKind: String, Codable, Sendable, Hashable, CaseIterable {
  case workingTree = "working-tree"
  case branchRange = "branch-range"
}

public struct DiffPreviewResult: Decodable, Sendable, Hashable {
  public var cwd: String
  public var generatedAt: String?
  public var sources: [DiffPreviewSource]
  public var incomplete: Bool
  public var completionToken: String?

  enum CodingKeys: String, CodingKey { case cwd, generatedAt, sources, incomplete, completionToken }

  public init(cwd: String, sources: [DiffPreviewSource], incomplete: Bool = false) {
    self.cwd = cwd
    self.sources = sources
    self.incomplete = incomplete
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    cwd = c.loose(String.self, .cwd) ?? ""
    generatedAt = c.loose(String.self, .generatedAt)
    sources = c.loose(LossyArray<DiffPreviewSource>.self, .sources)?.elements ?? []
    incomplete = c.loose(Bool.self, .incomplete) ?? false
    completionToken = c.loose(String.self, .completionToken)
  }
}

/// `ReviewDiffPreviewSource`: one comparison. A truncated source with `files` has its patches left
/// out; each file's patch is read on its own (`DiffPreviewRequest.file`).
public struct DiffPreviewSource: Decodable, Sendable, Hashable, Identifiable {
  public var id: String
  public var kind: String
  public var title: String
  public var baseRef: String?
  public var headRef: String?
  public var mergeBase: String?
  public var diff: String
  public var diffHash: String
  public var truncated: Bool
  public var files: [FileStat]?

  public struct FileStat: Decodable, Sendable, Hashable {
    public var path: String
    public var previousPath: String?
    public var changeType: String?
    public var additions: Int
    public var deletions: Int

    public init(path: String, previousPath: String? = nil, changeType: String? = nil, additions: Int, deletions: Int) {
      self.path = path
      self.previousPath = previousPath
      self.changeType = changeType
      self.additions = additions
      self.deletions = deletions
    }

    enum CodingKeys: String, CodingKey { case path, previousPath, changeType, additions, deletions }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      path = try c.decode(String.self, forKey: .path)
      previousPath = c.loose(String.self, .previousPath)
      changeType = c.loose(String.self, .changeType)
      additions = c.loose(Int.self, .additions) ?? 0
      deletions = c.loose(Int.self, .deletions) ?? 0
    }
  }

  public var gitKind: ReviewGitKind? { ReviewGitKind(rawValue: kind) }

  public init(
    id: String, kind: ReviewGitKind, title: String, baseRef: String? = nil, headRef: String? = nil, diff: String,
    diffHash: String, truncated: Bool = false, files: [FileStat]? = nil
  ) {
    self.id = id
    self.kind = kind.rawValue
    self.title = title
    self.baseRef = baseRef
    self.headRef = headRef
    self.diff = diff
    self.diffHash = diffHash
    self.truncated = truncated
    self.files = files
  }

  enum CodingKeys: String, CodingKey { case id, kind, title, baseRef, headRef, mergeBase, diff, diffHash, truncated, files }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = c.loose(String.self, .kind) ?? ""
    title = c.loose(String.self, .title) ?? ""
    baseRef = c.loose(String.self, .baseRef)
    headRef = c.loose(String.self, .headRef)
    mergeBase = c.loose(String.self, .mergeBase)
    diff = c.loose(String.self, .diff) ?? ""
    diffHash = c.loose(String.self, .diffHash) ?? ""
    truncated = c.loose(Bool.self, .truncated) ?? false
    files = c.loose(LossyArray<FileStat>.self, .files)?.elements
  }
}

/// `review.getDiffFileContents`: both sides of one file, for showing unchanged lines.
public struct DiffFileContentsRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "review.getDiffFileContents"
  public var cwd: String
  public var sourceKind: ReviewGitKind
  public var changeType: String
  public var baseRef: String?
  public var headRef: String?
  public var oldPath: String
  public var newPath: String

  public init(
    cwd: String, sourceKind: ReviewGitKind, changeType: String, baseRef: String?, headRef: String?, oldPath: String,
    newPath: String
  ) {
    self.cwd = cwd
    self.sourceKind = sourceKind
    self.changeType = changeType
    self.baseRef = baseRef
    self.headRef = headRef
    self.oldPath = oldPath
    self.newPath = newPath
  }

  enum CodingKeys: String, CodingKey { case cwd, sourceKind, changeType, baseRef, headRef, oldPath, newPath }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(cwd, forKey: .cwd)
    try c.encode(sourceKind, forKey: .sourceKind)
    try c.encode(changeType, forKey: .changeType)
    if let baseRef { try c.encode(baseRef, forKey: .baseRef) } else { try c.encodeNil(forKey: .baseRef) }
    if let headRef { try c.encode(headRef, forKey: .headRef) } else { try c.encodeNil(forKey: .headRef) }
    try c.encode(oldPath, forKey: .oldPath)
    try c.encode(newPath, forKey: .newPath)
  }
}

public struct DiffFileContents: Decodable, Sendable, Hashable {
  public var oldContents: String
  public var newContents: String

  public init(oldContents: String, newContents: String) {
    self.oldContents = oldContents
    self.newContents = newContents
  }
}

// MARK: Git status and actions

/// `vcs.refreshStatus`: reads the checkout now (local and remote state).
public struct VcsRefreshStatusRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "vcs.refreshStatus"
  public var cwd: String
  public var localOnly: Bool?

  public init(cwd: String, localOnly: Bool? = nil) {
    self.cwd = cwd
    self.localOnly = localOnly
  }
}

/// `VcsStatusResult` (also `VcsRefreshStatusResult`).
public struct VcsStatus: Decodable, Sendable, Hashable {
  public var isRepo: Bool
  public var hasPrimaryRemote: Bool
  public var isDefaultRef: Bool
  public var refName: String?
  public var hasWorkingTreeChanges: Bool
  public var workingTree: WorkingTree
  public var hasUpstream: Bool
  public var aheadCount: Int
  public var behindCount: Int

  public struct WorkingTree: Decodable, Sendable, Hashable {
    public var files: [File]
    public var insertions: Int
    public var deletions: Int

    public struct File: Decodable, Sendable, Hashable {
      public var path: String
      public var insertions: Int
      public var deletions: Int

      public init(path: String, insertions: Int, deletions: Int) {
        self.path = path
        self.insertions = insertions
        self.deletions = deletions
      }
    }

    public init(files: [File] = []) {
      self.files = files
      insertions = files.reduce(0) { $0 + $1.insertions }
      deletions = files.reduce(0) { $0 + $1.deletions }
    }

    enum CodingKeys: String, CodingKey { case files, insertions, deletions }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      files = c.loose(LossyArray<File>.self, .files)?.elements ?? []
      insertions = c.loose(Int.self, .insertions) ?? 0
      deletions = c.loose(Int.self, .deletions) ?? 0
    }
  }

  public init(
    isRepo: Bool = true, refName: String?, isDefaultRef: Bool = false, hasPrimaryRemote: Bool = true,
    workingTree: WorkingTree = WorkingTree(), hasUpstream: Bool = true, aheadCount: Int = 0, behindCount: Int = 0,
  ) {
    self.isRepo = isRepo
    self.refName = refName
    self.isDefaultRef = isDefaultRef
    self.hasPrimaryRemote = hasPrimaryRemote
    self.workingTree = workingTree
    hasWorkingTreeChanges = !workingTree.files.isEmpty
    self.hasUpstream = hasUpstream
    self.aheadCount = aheadCount
    self.behindCount = behindCount
  }

  enum CodingKeys: String, CodingKey {
    case isRepo, hasPrimaryRemote, isDefaultRef, refName, hasWorkingTreeChanges, workingTree
    case hasUpstream, aheadCount, behindCount
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    isRepo = c.loose(Bool.self, .isRepo) ?? false
    hasPrimaryRemote = c.loose(Bool.self, .hasPrimaryRemote) ?? false
    isDefaultRef = c.loose(Bool.self, .isDefaultRef) ?? false
    refName = c.loose(String.self, .refName)
    hasWorkingTreeChanges = c.loose(Bool.self, .hasWorkingTreeChanges) ?? false
    workingTree = c.loose(WorkingTree.self, .workingTree) ?? WorkingTree()
    hasUpstream = c.loose(Bool.self, .hasUpstream) ?? false
    aheadCount = c.loose(Int.self, .aheadCount) ?? 0
    behindCount = c.loose(Int.self, .behindCount) ?? 0
  }
}

/// `vcs.pull`.
public struct VcsPullRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "vcs.pull"
  public var cwd: String
  public init(cwd: String) { self.cwd = cwd }
}

public struct VcsPullResult: Decodable, Sendable, Hashable {
  /// `pulled` or `skipped_up_to_date`.
  public var status: String
  public var refName: String
}

/// `GitStackedAction`. A current server refuses the retired pull request actions, so there are none.
public enum GitStackedAction: String, Codable, Sendable, Hashable, CaseIterable {
  case commit, push
  case commitPush = "commit_push"

  /// Actions that publish, and so ask first on the default branch (`requiresDefaultBranchConfirmation`).
  public var publishes: Bool { self != .commit }
  public var includesCommit: Bool { self != .push }
}

/// `git.runStackedAction` (a stream of `GitActionProgressEvent`).
public struct GitStackedActionRequest: Encodable, Sendable, Hashable {
  public static let rpcTag = "git.runStackedAction"
  public var actionId: String
  public var cwd: String
  public var action: GitStackedAction
  public var commitMessage: String?
  public var featureBranch: Bool?
  public var filePaths: [String]?
  public var threadId: String?

  /// Unset options are left out, as RN does: an empty message or file list would be refused.
  public init(
    actionId: String, cwd: String, action: GitStackedAction, commitMessage: String? = nil, featureBranch: Bool = false,
    filePaths: [String]? = nil, threadId: String? = nil
  ) {
    self.actionId = actionId
    self.cwd = cwd
    self.action = action
    let message = commitMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.commitMessage = message?.isEmpty == false ? message : nil
    self.featureBranch = featureBranch ? true : nil
    self.filePaths = filePaths?.isEmpty == false ? filePaths : nil
    self.threadId = threadId
  }
}

/// `GitActionProgressEvent`. Decoding never throws: an event this client cannot read becomes
/// `.unknown`, because one undecodable item fails the whole chunk (spec §14 #24).
public enum GitActionProgress: Decodable, Sendable, Hashable {
  case started(phases: [String])
  case phaseStarted(phase: String, label: String)
  case hookStarted(name: String)
  case hookOutput(text: String)
  case hookFinished(name: String)
  case finished(GitStackedActionResult)
  case failed(phase: String?, message: String)
  case unknown

  enum CodingKeys: String, CodingKey { case kind, phases, phase, label, hookName, text, result, message, actionId }

  public init(from decoder: any Decoder) {
    guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
      self = .unknown
      return
    }
    switch c.loose(String.self, .kind) {
    case "action_started": self = .started(phases: c.loose([String].self, .phases) ?? [])
    case "phase_started": self = .phaseStarted(phase: c.loose(String.self, .phase) ?? "", label: c.loose(String.self, .label) ?? "")
    case "hook_started": self = .hookStarted(name: c.loose(String.self, .hookName) ?? "")
    case "hook_output": self = .hookOutput(text: c.loose(String.self, .text) ?? "")
    case "hook_finished": self = .hookFinished(name: c.loose(String.self, .hookName) ?? "")
    case "action_finished":
      if let result = c.loose(GitStackedActionResult.self, .result) { self = .finished(result) } else { self = .unknown }
    case "action_failed": self = .failed(phase: c.loose(String.self, .phase), message: c.loose(String.self, .message) ?? "")
    default: self = .unknown
    }
  }
}

/// `GitRunStackedActionResult`, the parts the result toast and branch sync read. An older server's
/// pull request step and "View PR" toast action are not read.
public struct GitStackedActionResult: Decodable, Sendable, Hashable {
  public var action: String
  public var branch: Branch
  public var toast: Toast

  public struct Branch: Decodable, Sendable, Hashable {
    /// `created` or `skipped_not_requested`.
    public var status: String
    public var name: String?
  }

  public struct Toast: Decodable, Sendable, Hashable {
    public var title: String
    public var description: String?

    public init(title: String, description: String? = nil) {
      self.title = title
      self.description = description
    }
  }

  public init(action: GitStackedAction, branchCreated: String? = nil, toast: Toast) {
    self.action = action.rawValue
    branch = Branch(status: branchCreated == nil ? "skipped_not_requested" : "created", name: branchCreated)
    self.toast = toast
  }
}

/// `thread.metadata.update` with a new branch (after a stacked action created one).
public struct ThreadBranchUpdate: Encodable, Sendable, Hashable {
  public static let rpcTag = ThreadCommand.rpcTag
  public var commandId: String
  public var threadId: String
  public var branch: String
  /// Sent as is (RN passes the thread's current worktree, `null` for none).
  public var worktreePath: String?

  public init(commandId: String, threadId: String, branch: String, worktreePath: String?) {
    self.commandId = commandId
    self.threadId = threadId
    self.branch = branch
    self.worktreePath = worktreePath
  }

  enum CodingKeys: String, CodingKey { case type, commandId, threadId, branch, worktreePath }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("thread.metadata.update", forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(branch, forKey: .branch)
    if let worktreePath { try c.encode(worktreePath, forKey: .worktreePath) } else { try c.encodeNil(forKey: .worktreePath) }
  }
}
