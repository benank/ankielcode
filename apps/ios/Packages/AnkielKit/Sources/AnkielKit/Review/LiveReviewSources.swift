import Foundation

/// Review reads on an environment's live session.
@MainActor
public final class LiveReviewSource: ReviewSource {
  let registry: EnvironmentRegistry
  let environmentId: String

  public init(registry: EnvironmentRegistry, environmentId: String) {
    self.registry = registry
    self.environmentId = environmentId
  }

  public func turnDiff(threadId: String, turn: Int) async throws -> ThreadTurnDiff {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.turnDiff(threadId: threadId, turn: turn, via: $0) }
  }

  public func preview(
    cwd: String, kind: ReviewGitKind, partial: @escaping @Sendable (DiffPreviewResult) async -> Void
  ) async throws -> DiffPreviewResult {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.preview(cwd: cwd, kind: kind, via: $0, partial: partial) }
  }

  public func filePatch(cwd: String, source: DiffPreviewSource, file: DiffPreviewSource.FileStat) async throws -> DiffPreviewSource? {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.filePatch(cwd: cwd, source: source, file: file, via: $0) }
  }

  public func fileContents(cwd: String, source: DiffPreviewSource, file: DiffFile) async throws -> DiffFileContents? {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.fileContents(cwd: cwd, source: source, file: file, via: $0) }
  }
}

/// Git status and actions on an environment's live session.
@MainActor
public final class LiveGitSource: GitSource {
  let registry: EnvironmentRegistry
  let environmentId: String

  public init(registry: EnvironmentRegistry, environmentId: String) {
    self.registry = registry
    self.environmentId = environmentId
  }

  public func status(cwd: String) async throws -> VcsStatus {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.status(cwd: cwd, via: $0) }
  }

  public func pull(cwd: String) async throws -> VcsPullResult {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.pull(cwd: cwd, via: $0) }
  }

  public func run(_ request: GitStackedActionRequest) async throws -> AsyncThrowingStream<GitActionProgress, any Error> {
    let stream = try await registry.gitActionStream(request, in: environmentId)
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await event in stream { continuation.yield(event) }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  public func localBranches(cwd: String) async throws -> [String] {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.localBranches(cwd: cwd, via: $0) }
  }

  public func createBranch(cwd: String, name: String) async throws -> String {
    try await registry.reviewCall(environmentId) { try await ReviewCalls.createBranch(cwd: cwd, name: name, via: $0) }
  }

  public func setThreadBranch(threadId: String, branch: String, worktreePath: String?) async throws {
    let command = ThreadBranchUpdate(
      commandId: UUID().uuidString.lowercased(), threadId: threadId, branch: branch, worktreePath: worktreePath)
    _ = try await registry.reviewCall(environmentId) {
      try await $0.call(ThreadBranchUpdate.rpcTag, payload: command, as: DispatchResult.self)
    }
  }
}
