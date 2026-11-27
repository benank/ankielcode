import AnkielKit
import Foundation

/// `--diff [threadId]`: read-only. Every thread with checkpoints (or just `threadId`): its turns
/// with changes, each turn's diff parsed, then the thread checkout's git status, both git
/// comparisons (tracked-only read, then the completion read), one file's lazy patch and the
/// file contents check that unchanged lines need. Nothing is written.
func probeDiff(_ session: EnvironmentSession, only threadId: String?) async throws {
  let shellStream = try await session.subscribeShell(session.initialConfig.shellSubscription)
  var shell = ShellState(awaitingCompletion: true)
  for try await item in shellStream {
    shell.apply(item)
    if shell.status == .live { break }
  }
  let threads = shell.threads.filter { threadId == nil || $0.id == threadId }
  print("threads:           \(threads.count)")
  var checkedGit = Set<String>()
  for thread in threads {
    let projection = try await snapshot(session, threadId: thread.id)
    let turns = TurnChange.derive(projection)
    let cwd = thread.worktreePath ?? shell.projects.first { $0.id == thread.projectId }?.workspaceRoot
    guard !turns.isEmpty || threadId != nil else { continue }
    print("\n\(thread.title) [\(thread.id)] cwd=\(cwd ?? "nil")")
    print("  checkpoints \(projection.checkpoints.count), scopes \(projection.checkpointScopes.count), turns with changes \(turns.count)")
    for turn in turns.prefix(4) {
      let started = ContinuousClock.now
      let diff = try await ReviewCalls.turnDiff(threadId: thread.id, turn: turn.turnCount, via: session.rpc)
      let text = diff.reviewText
      let parsed = UnifiedDiff.parse(text)
      let ordered = DiffFileOrder.order(parsed.files)
      let elapsed = ContinuousClock.now - started
      print(
        "  turn \(turn.turnCount) [\(turn.status)] checkpoint files \(turn.totals.count) +\(turn.totals.additions) −\(turn.totals.deletions)"
          + " | diff \(text.utf8.count) B, \(parsed.files.count) files +\(parsed.additions) −\(parsed.deletions)"
          + "\(parsed.truncated ? " TRUNCATED" : "") repos \(diff.repositories.count) (\(elapsed.formatted(.units(allowed: [.milliseconds]))))")
      for file in ordered.prefix(6) {
        let rows = DiffRows.build(file)
        print(
          "    \(file.status.rawValue.padding(toLength: 8, withPad: " ", startingAt: 0)) \(file.previousPath.map { "\($0) → " } ?? "")\(file.path)"
            + " +\(file.additions) −\(file.deletions) hunks \(file.hunks.count) rows \(rows.count)\(file.isBinary ? " binary" : "")\(file.modeChanged ? " mode \(file.oldMode ?? "")→\(file.newMode ?? "")" : "")")
      }
      if turn.files.count != parsed.files.count, turn.filesTotal == nil {
        print("    note: checkpoint lists \(turn.files.count) files, the patch \(parsed.files.count)")
      }
    }
    guard let cwd, checkedGit.insert(cwd).inserted else { continue }
    try await probeGit(session, cwd: cwd)
  }
}

private func snapshot(_ session: EnvironmentSession, threadId: String) async throws -> ThreadProjection {
  let stream = try await session.rpc.stream(ThreadSubscription.rpcTag, payload: ThreadSubscription(threadId: threadId), of: ThreadStreamItem.self)
  for try await item in stream {
    if case .snapshot(let snapshot) = item { return snapshot.projection }
  }
  throw ProbeFailure(description: "No snapshot for \(threadId)")
}

private func probeGit(_ session: EnvironmentSession, cwd: String) async throws {
  do {
    let status = try await ReviewCalls.status(cwd: cwd, via: session.rpc)
    print(
      "  git: repo=\(status.isRepo) ref=\(status.refName ?? "detached") default=\(status.isDefaultRef) dirty=\(status.hasWorkingTreeChanges) (\(status.workingTree.files.count) files)"
        + " upstream=\(status.hasUpstream) ahead=\(status.aheadCount) behind=\(status.behindCount) remote=\(status.hasPrimaryRemote) pr=\(status.pr.map { "#\($0.number) \($0.state)" } ?? "none")")
    print("  quick action: \(GitActionRules.quickAction(status, busy: false))")
    print("  menu: \(GitActionRules.menuItems(status, busy: false).map { "\($0.id.rawValue)\($0.disabled ? "(off: \(String(describing: GitActionRules.disabledReason($0, status: status, busy: false)!)))" : "")" }.joined(separator: ", "))")
  } catch {
    print("  git status failed: \(error)")
  }
  for kind in ReviewGitKind.allCases {
    do {
      let partials = Counter()
      let result = try await ReviewCalls.preview(cwd: cwd, kind: kind, via: session.rpc) { partial in
        await partials.bump()
        print("  \(kind.rawValue): tracked-only read incomplete=\(partial.incomplete) token=\(partial.completionToken != nil)")
      }
      let partialCount = await partials.value
      for source in result.sources {
        let parsed = UnifiedDiff.parse(source.diff)
        print(
          "  \(kind.rawValue): \(source.title) base=\(source.baseRef ?? "nil") head=\(source.headRef ?? "nil") truncated=\(source.truncated)"
            + " stats \(source.files?.count ?? -1) parsed \(parsed.files.count) files \(source.diff.utf8.count) B (partial reads \(partialCount))")
        if source.truncated, let stat = source.files?.first {
          let patch = try await ReviewCalls.filePatch(cwd: cwd, source: source, file: stat, via: session.rpc)
          print("    lazy patch \(stat.path): \(patch.map { "\(UnifiedDiff.parse($0.diff).files.count) file, \($0.diff.utf8.count) B" } ?? "none")")
        }
        if let file = parsed.files.first(where: { $0.status == .modified && !$0.isBinary }) {
          let contents = try await ReviewCalls.fileContents(cwd: cwd, source: source, file: file, via: session.rpc)
          let verified = contents.flatMap { DiffRows.verifiedLines(file, contents: $0) }
          let rows = DiffRows.build(file, contents: verified, expanded: Set(0...file.hunks.count))
          print("    contents \(file.path): reproduces patch=\(verified != nil) expanded rows \(rows.count) (patch rows \(DiffRows.build(file).count))")
        }
      }
    } catch {
      print("  \(kind.rawValue) failed: \(error)")
    }
  }
}

private actor Counter {
  var value = 0
  func bump() { value += 1 }
}

/// `--git-actions <cwd>`: writes. Runs commit (one file), commit on a feature branch, push and
/// pull in `cwd`, printing progress. Only for a throwaway repository.
func probeGitActions(_ session: EnvironmentSession, cwd: String) async throws {
  func show(_ label: String) async throws {
    let status = try await ReviewCalls.status(cwd: cwd, via: session.rpc)
    print("  \(label): ref=\(status.refName ?? "detached") default=\(status.isDefaultRef) dirty=\(status.workingTree.files.map(\.path)) upstream=\(status.hasUpstream) ahead=\(status.aheadCount) behind=\(status.behindCount) quick=\(GitActionRules.quickAction(status, busy: false))")
  }
  func run(_ request: GitStackedActionRequest) async throws {
    print("  run \(request.action.rawValue) featureBranch=\(request.featureBranch ?? false) files=\(request.filePaths ?? [])")
    for try await event in try await session.rpc.stream(GitStackedActionRequest.rpcTag, payload: request, of: GitActionProgress.self) {
      print("    \(event)")
    }
  }
  try await show("before")
  try await run(GitStackedActionRequest(actionId: UUID().uuidString, cwd: cwd, action: .commit, commitMessage: "Edit a", filePaths: ["a.txt"]))
  try await show("after commit a.txt")
  try await run(GitStackedActionRequest(actionId: UUID().uuidString, cwd: cwd, action: .push))
  try await show("after push")
  try await run(GitStackedActionRequest(actionId: UUID().uuidString, cwd: cwd, action: .commit, commitMessage: "Add b", featureBranch: true))
  try await show("after feature-branch commit")
  let branches = try await ReviewCalls.localBranches(cwd: cwd, via: session.rpc)
  print("  local branches: \(branches) → next feature name \(GitActionRules.autoFeatureBranchName(existing: branches))")
  let pulled = try await ReviewCalls.pull(cwd: cwd, via: session.rpc)
  print("  pull: \(pulled.status) on \(pulled.refName)")
}
