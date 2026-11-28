import Foundation

/// Which git actions a checkout offers, a port of `client-runtime/src/state/gitActions.ts`. The
/// app turns these values into copy; nothing here is user-facing text.
public enum GitActionRules {
  public enum MenuItemID: String, Sendable, Hashable { case commit, push }

  public struct MenuItem: Sendable, Hashable, Identifiable {
    public var id: MenuItemID
    public var disabled: Bool
  }

  /// The Git sheet's rows (`buildMenuItems`).
  public static func menuItems(_ status: VcsStatus?, busy: Bool) -> [MenuItem] {
    guard let status else { return [] }
    let hasBranch = status.refName != nil
    let hasChanges = status.hasWorkingTreeChanges
    let isBehind = status.behindCount > 0
    let canPushWithoutUpstream = status.hasPrimaryRemote && !status.hasUpstream
    let canCommit = !busy && hasChanges
    let canPush = !busy && hasBranch && !hasChanges && !isBehind && status.aheadCount > 0
      && (status.hasUpstream || canPushWithoutUpstream)
    return [MenuItem(id: .commit, disabled: !canCommit), MenuItem(id: .push, disabled: !canPush)]
  }

  public enum QuickAction: Sendable, Hashable {
    case run(GitStackedAction)
    case pull
    /// Unavailable, with why (the label shows `labelAction`).
    case hint(Hint, labelAction: HintLabel)
  }

  public enum HintLabel: Sendable, Hashable { case commit, push, sync }

  public enum Hint: Sendable, Hashable {
    case inProgress, statusUnavailable, noBranch, noOriginRemote, noLocalCommits, diverged, upToDate
  }

  /// The one-tap action in the thread's git menu (`resolveQuickAction`).
  public static func quickAction(_ status: VcsStatus?, busy: Bool) -> QuickAction {
    if busy { return .hint(.inProgress, labelAction: .commit) }
    guard let status else { return .hint(.statusUnavailable, labelAction: .commit) }
    let isAhead = status.aheadCount > 0
    let isBehind = status.behindCount > 0
    guard status.refName != nil else { return .hint(.noBranch, labelAction: .commit) }
    if status.hasWorkingTreeChanges {
      if isBehind || (!status.hasUpstream && !status.hasPrimaryRemote) { return .run(.commit) }
      return .run(.commitPush)
    }
    if !status.hasUpstream {
      if !status.hasPrimaryRemote { return .hint(.noOriginRemote, labelAction: .push) }
      if !isAhead { return .hint(.noLocalCommits, labelAction: .push) }
      return .run(.push)
    }
    if isAhead, isBehind { return .hint(.diverged, labelAction: .sync) }
    if isBehind { return .pull }
    if isAhead { return .run(.push) }
    return .hint(.upToDate, labelAction: .commit)
  }

  public enum DisabledReason: Sendable, Hashable {
    case inProgress, statusUnavailable
    case commitClean, commitUnavailable
    case pushDetached, pushDirty, pushBehind, pushNoOrigin, pushNothing, pushUnavailable
  }

  /// Why a disabled Git sheet row is disabled (`getGitActionDisabledReason`).
  public static func disabledReason(_ item: MenuItem, status: VcsStatus?, busy: Bool) -> DisabledReason? {
    guard item.disabled else { return nil }
    if busy { return .inProgress }
    guard let status else { return .statusUnavailable }
    switch item.id {
    case .commit:
      return status.hasWorkingTreeChanges ? .commitUnavailable : .commitClean
    case .push:
      if status.refName == nil { return .pushDetached }
      if status.hasWorkingTreeChanges { return .pushDirty }
      if status.behindCount > 0 { return .pushBehind }
      if !status.hasUpstream, !status.hasPrimaryRemote { return .pushNoOrigin }
      if status.aheadCount == 0 { return .pushNothing }
      return .pushUnavailable
    }
  }

  /// Publishing from the default branch asks first (`requiresDefaultBranchConfirmation`).
  public static func needsDefaultBranchConfirmation(_ action: GitStackedAction, status: VcsStatus?) -> Bool {
    guard let status, status.refName != nil else { return false }
    return status.isDefaultRef && action.publishes
  }

  /// A free feature branch name from the local branches (`resolveAutoFeatureBranchName`).
  public static func autoFeatureBranchName(existing: [String]) -> String {
    let names = existing.map { $0.lowercased() }
    let refs = Set(names)
    var resolved = ""
    let parts = "feature/update".split(separator: "/")
    for (index, part) in parts.enumerated() {
      let base = resolved.isEmpty ? String(part) : "\(resolved)/\(part)"
      var candidate = base
      var suffix = 2
      while refs.contains(candidate) || (index == parts.count - 1 && names.contains { $0.hasPrefix("\(candidate)/") }) {
        candidate = "\(base)-\(suffix)"
        suffix += 1
      }
      resolved = candidate
    }
    return resolved
  }
}
