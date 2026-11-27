import Foundation
import Observation

/// Where git state and actions go: a live session, or a fake in debug builds and UI tests.
@MainActor
public protocol GitSource: AnyObject {
  func status(cwd: String) async throws -> VcsStatus
  func pull(cwd: String) async throws -> VcsPullResult
  func run(_ request: GitStackedActionRequest) async throws -> AsyncThrowingStream<GitActionProgress, any Error>
  func localBranches(cwd: String) async throws -> [String]
  func createBranch(cwd: String, name: String) async throws -> String
  /// Records the thread's new branch (`thread.metadata.update`).
  func setThreadBranch(threadId: String, branch: String, worktreePath: String?) async throws
}

/// What the thread shows while a git action runs and after it ends (RN `GitActionProgress`).
public enum GitProgress: Sendable, Hashable {
  case idle
  case running(GitProgressLabel, detail: String?, since: Date)
  case succeeded(GitResult)
  case failed(message: String)

  public var isRunning: Bool { if case .running = self { true } else { false } }
}

public enum GitProgressLabel: Sendable, Hashable {
  case runningAction
  case pulling
  case refreshing
  /// The server's phase label ("Committing…").
  case phase(String)
  case hook(String)
}

public enum GitResult: Sendable, Hashable {
  case action(title: String, description: String?, prURL: URL?)
  case upToDate
  case pulled(branch: String)
}

/// One input to `git.runStackedAction`.
public struct GitActionInput: Sendable, Hashable {
  public var action: GitStackedAction
  public var commitMessage: String?
  public var filePaths: [String]?
  public var featureBranch: Bool

  public init(_ action: GitStackedAction, commitMessage: String? = nil, filePaths: [String]? = nil, featureBranch: Bool = false) {
    self.action = action
    self.commitMessage = commitMessage
    self.filePaths = filePaths
    self.featureBranch = featureBranch
  }
}

/// The thread checkout's git status and the actions RN mobile offers on it: commit (with a
/// message and a file selection), push, create or open a change request, pull, and the
/// default-branch confirmation's "feature branch and continue".
@MainActor @Observable
public final class GitModel {
  public let ref: ThreadRef
  public private(set) var cwd: String?
  /// The thread's worktree, sent back with a branch change.
  public private(set) var worktreePath: String?
  public private(set) var status: VcsStatus?
  public private(set) var statusError: ReviewFailure?
  public private(set) var progress = GitProgress.idle
  /// Bumped when an action finishes (haptics).
  public private(set) var finishedCount = 0
  public private(set) var failedCount = 0
  /// Whether this session may change source control (`source-control:write`) and the thread's
  /// branch (`orchestration:operate` too).
  public var canWrite = true
  public var canOperateThread = true

  @ObservationIgnored private let source: GitSource
  @ObservationIgnored private var dismissal: Task<Void, Never>?
  @ObservationIgnored private let makeId: () -> String

  public init(ref: ThreadRef, source: GitSource, makeId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
    self.ref = ref
    self.source = source
    self.makeId = makeId
  }

  public var busy: Bool { progress.isRunning }
  public var canCreateFeatureBranch: Bool { canWrite && canOperateThread }

  public func update(cwd: String?, worktreePath: String?) {
    self.worktreePath = worktreePath
    guard self.cwd != cwd else { return }
    self.cwd = cwd
    status = nil
    statusError = nil
  }

  public var quickAction: GitActionRules.QuickAction { GitActionRules.quickAction(status, busy: busy) }
  public var menuItems: [GitActionRules.MenuItem] { GitActionRules.menuItems(status, busy: busy) }

  // MARK: Status

  /// Reads the checkout now. `quiet` refreshes without showing progress.
  public func refresh(quiet: Bool = true) async {
    guard let cwd else { return }
    if !quiet, !busy { progress = .running(.refreshing, detail: nil, since: .now) }
    do {
      status = try await source.status(cwd: cwd)
      statusError = nil
    } catch {
      statusError = ReviewFailure(error)
    }
    if !quiet, case .running(.refreshing, _, _) = progress { progress = .idle }
  }

  // MARK: Actions

  public func pull() async {
    guard let cwd, canWrite, !busy else { return }
    progress = .running(.pulling, detail: nil, since: .now)
    do {
      let result = try await source.pull(cwd: cwd)
      await refresh()
      finish(.succeeded(result.status == "skipped_up_to_date" ? .upToDate : .pulled(branch: result.refName)))
    } catch {
      finish(.failed(message: Self.describe(error)))
    }
  }

  /// Runs a stacked action as asked (the caller handled the default-branch confirmation).
  public func run(_ input: GitActionInput) async {
    guard let cwd, canWrite, !busy, !input.featureBranch || canCreateFeatureBranch else { return }
    progress = .running(.runningAction, detail: nil, since: .now)
    let request = GitStackedActionRequest(
      actionId: makeId(), cwd: cwd, action: input.action, commitMessage: input.commitMessage,
      featureBranch: input.featureBranch, filePaths: input.filePaths, threadId: ref.threadId)
    do {
      var result: GitStackedActionResult?
      var failure: String?
      for try await event in try await source.run(request) {
        switch event {
        case .started: break
        case .phaseStarted(_, let label):
          progress = .running(label.isEmpty ? .runningAction : .phase(label), detail: nil, since: .now)
        case .hookStarted(let name):
          progress = .running(.hook(name), detail: nil, since: .now)
        case .hookOutput(let text):
          if case .running(let label, _, let since) = progress { progress = .running(label, detail: text, since: since) }
        case .hookFinished:
          break
        case .finished(let finished): result = finished
        case .failed(_, let message): failure = message
        case .unknown: break
        }
      }
      if let failure { throw GitActionFailure(message: failure) }
      guard let result else { throw GitActionFailure(message: "") }
      if result.branch.status == "created", let name = result.branch.name {
        try await source.setThreadBranch(threadId: ref.threadId, branch: name, worktreePath: worktreePath)
      }
      await refresh()
      finish(.succeeded(.action(title: result.toast.title, description: result.toast.description, prURL: result.prURL)))
    } catch {
      await refresh()
      finish(.failed(message: Self.describe(error)))
    }
  }

  /// "Feature branch & continue" from the default-branch confirmation: a commit takes
  /// `featureBranch`; a push or change request first moves to a new branch (RN
  /// `movePendingActionToFeatureBranch`).
  public func runOnFeatureBranch(_ action: GitStackedAction) async {
    guard let cwd, canCreateFeatureBranch, !busy else { return }
    if action.includesCommit {
      await run(GitActionInput(action, featureBranch: true))
      return
    }
    progress = .running(.runningAction, detail: nil, since: .now)
    do {
      let branches = try await source.localBranches(cwd: cwd)
      let created = try await source.createBranch(cwd: cwd, name: GitActionRules.autoFeatureBranchName(existing: branches))
      try await source.setThreadBranch(threadId: ref.threadId, branch: created, worktreePath: worktreePath)
      await refresh()
    } catch {
      finish(.failed(message: Self.describe(error)))
      return
    }
    progress = .idle
    await run(GitActionInput(action))
  }

  public func dismissProgress() {
    dismissal?.cancel()
    if !busy { progress = .idle }
  }

  private func finish(_ next: GitProgress) {
    progress = next
    if case .failed = next { failedCount += 1 } else { finishedCount += 1 }
    dismissal?.cancel()
    // RN `RESULT_DISMISS_MS`.
    dismissal = Task { [weak self] in
      try? await Task.sleep(for: .seconds(5))
      guard !Task.isCancelled, let self, !self.busy else { return }
      self.progress = .idle
    }
  }

  static func describe(_ error: any Error) -> String {
    if let failure = error as? GitActionFailure { return failure.message }
    switch ReviewFailure(error) {
    case .server(let message): return message
    case .offline, .tooLarge, .changedSince: return ""
    }
  }
}

/// `action_failed`, or a stream that ended without a result (empty message: the app says
/// "Git action failed.").
struct GitActionFailure: Error {
  var message: String
}
