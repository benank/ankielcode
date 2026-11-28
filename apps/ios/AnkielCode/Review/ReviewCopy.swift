import AnkielKit
import Foundation

/// User-facing words for review and git values (RN's English, through the String Catalog).
enum ReviewCopy {
  static func title(_ id: ReviewSectionID) -> String {
    switch id {
    case .turn(let count): String(localized: "Turn \(count)")
    case .git(.workingTree): String(localized: "Uncommitted", comment: "diff section: working tree")
    case .git(.branchRange): String(localized: "Changes", comment: "diff section: branch changes")
    }
  }

  static func subtitle(_ section: ReviewSection) -> String? {
    if let turn = section.turn {
      if turn.status != "ready", !turn.hasChanges { return String(localized: "Diff \(turn.status)") }
      let files = String(localized: "\(turn.totals.count) files changed")
      let repositories = turn.repositories.map(\.name)
      return repositories.isEmpty ? files : "\(files) · \(repositories.joined(separator: ", "))"
    }
    switch section.id {
    case .git(.workingTree): return String(localized: "Staged, unstaged, and untracked files")
    case .git(.branchRange):
      guard let source = section.source else { return nil }
      if let base = source.baseRef { return "\(base) ... \(source.headRef ?? "HEAD")" }
      return String(localized: "Base branch unavailable")
    case .turn: return nil
    }
  }

  static func failure(_ failure: ReviewFailure) -> String {
    switch failure {
    case .offline: String(localized: "Not connected to this computer.")
    case .tooLarge: String(localized: "Large diffs are not rendered by default.")
    case .changedSince: String(localized: "This file changed since the diff was loaded. Refresh the diff to expand it.")
    case .server(let message): message
    }
  }

  static func status(_ status: DiffFile.Status) -> String {
    switch status {
    case .added: String(localized: "Added", comment: "diff file status")
    case .modified: String(localized: "Modified", comment: "diff file status")
    case .deleted: String(localized: "Deleted", comment: "diff file status")
    case .renamed: String(localized: "Renamed", comment: "diff file status")
    case .copied: String(localized: "Copied", comment: "diff file status")
    }
  }

  static func statusSymbol(_ status: DiffFile.Status) -> String {
    switch status {
    case .added: "plus.square"
    case .modified: "square.and.pencil"
    case .deleted: "minus.square"
    case .renamed: "arrow.right.square"
    case .copied: "plus.square.on.square"
    }
  }

  // MARK: Git

  static func quickLabel(_ action: GitActionRules.QuickAction) -> String {
    switch action {
    case .run(let action): return actionLabel(action)
    case .pull: return String(localized: "Pull", comment: "verb, git action")
    case .hint(_, let label):
      switch label {
      case .commit: return String(localized: "Commit", comment: "verb, git action")
      case .push: return String(localized: "Push", comment: "verb, git action")
      case .sync: return String(localized: "Sync branch")
      }
    }
  }

  static func actionLabel(_ action: GitStackedAction) -> String {
    switch action {
    case .commit: String(localized: "Commit", comment: "verb, git action")
    case .push: String(localized: "Push", comment: "verb, git action")
    case .commitPush: String(localized: "Commit & push")
    }
  }

  static func hint(_ hint: GitActionRules.Hint) -> String {
    switch hint {
    case .inProgress: String(localized: "Git action in progress.")
    case .statusUnavailable: String(localized: "Git status is unavailable.")
    case .noBranch: String(localized: "Create and checkout a branch before pushing.")
    case .noOriginRemote: String(localized: "Add an \"origin\" remote before pushing.")
    case .noLocalCommits: String(localized: "No local commits to push.")
    case .diverged: String(localized: "Branch has diverged from upstream. Rebase/merge first.")
    case .upToDate: String(localized: "Branch is up to date. No action needed.")
    }
  }

  static func menuLabel(_ item: GitActionRules.MenuItem) -> String {
    switch item.id {
    case .commit: String(localized: "Commit", comment: "verb, git action")
    case .push: String(localized: "Push", comment: "verb, git action")
    }
  }

  static func menuSymbol(_ id: GitActionRules.MenuItemID) -> String {
    switch id {
    case .commit: "checkmark.circle"
    case .push: "arrow.up.circle"
    }
  }

  static func reason(_ reason: GitActionRules.DisabledReason) -> String {
    switch reason {
    case .inProgress: String(localized: "Git action in progress.")
    case .statusUnavailable: String(localized: "Git status is unavailable.")
    case .commitClean: String(localized: "Worktree is clean. Make changes before committing.")
    case .commitUnavailable: String(localized: "Commit is currently unavailable.")
    case .pushDetached: String(localized: "Detached HEAD: checkout a branch before pushing.")
    case .pushDirty: String(localized: "Commit or stash local changes before pushing.")
    case .pushBehind: String(localized: "Branch is behind upstream. Pull/rebase before pushing.")
    case .pushNoOrigin: String(localized: "Add an \"origin\" remote before pushing.")
    case .pushNothing: String(localized: "No local commits to push.")
    case .pushUnavailable: String(localized: "Push is currently unavailable.")
    }
  }

  /// "3 files changed · 2 ahead" (RN `statusSummary`).
  static func statusSummary(_ status: VcsStatus?) -> String {
    guard let status else { return String(localized: "Loading branch status…") }
    guard status.isRepo else { return String(localized: "Not a git repository") }
    var parts: [String] = []
    if status.hasWorkingTreeChanges {
      parts.append(String(localized: "\(status.workingTree.files.count) files changed"))
    } else {
      parts.append(String(localized: "Clean", comment: "git working tree has no changes"))
    }
    if status.aheadCount > 0 { parts.append(String(localized: "\(status.aheadCount) ahead")) }
    if status.behindCount > 0 { parts.append(String(localized: "\(status.behindCount) behind")) }
    return parts.joined(separator: " · ")
  }

  static func progressLabel(_ label: GitProgressLabel) -> String {
    switch label {
    case .runningAction: String(localized: "Running source control action")
    case .pulling: String(localized: "Pulling latest changes")
    case .refreshing: String(localized: "Refreshing source control status")
    case .phase(let label): label
    case .hook(let name): String(localized: "Running \(name)...")
    }
  }

  static func result(_ result: GitResult) -> (title: String, description: String?) {
    switch result {
    case .action(let title, let description): (title, description)
    case .upToDate: (String(localized: "Already up to date"), nil)
    case .pulled(let branch): (String(localized: "Pulled latest on \(branch)"), nil)
    }
  }

  /// RN `resolveDefaultBranchActionDialogCopy`.
  static func defaultBranchCopy(_ action: GitStackedAction, branch: String) -> (title: String, description: String, continueLabel: String) {
    if action.includesCommit {
      return (
        String(localized: "Commit & push to default branch?"),
        String(localized: "This action will commit and push changes on \"\(branch)\". You can continue on this branch or create a feature branch and run the same action there."),
        String(localized: "Commit & push to \(branch)")
      )
    }
    return (
      String(localized: "Push to default branch?"),
      String(localized: "This action will push local commits on \"\(branch)\". You can continue on this branch or create a feature branch and run the same action there."),
      String(localized: "Push to \(branch)")
    )
  }
}
