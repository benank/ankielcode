import Foundation

/// Which git actions a checkout offers, a port of `client-runtime/src/state/gitActions.ts`. The
/// app turns these values into copy; nothing here is user-facing text.
public enum GitActionRules {
  public enum MenuItemID: String, Sendable, Hashable { case commit, push, pr }

  public struct MenuItem: Sendable, Hashable, Identifiable {
    public var id: MenuItemID
    public var disabled: Bool
    /// `pr` opens the existing change request instead of creating one.
    public var opensExisting: Bool
  }

  /// The Git sheet's rows (`buildMenuItems`).
  public static func menuItems(_ status: VcsStatus?, busy: Bool) -> [MenuItem] {
    guard let status else { return [] }
    let hasBranch = status.refName != nil
    let hasChanges = status.hasWorkingTreeChanges
    let hasOpenPR = status.openChangeRequest != nil
    let isBehind = status.behindCount > 0
    let canPushWithoutUpstream = status.hasPrimaryRemote && !status.hasUpstream
    let canCommit = !busy && hasChanges
    let canPush = !busy && hasBranch && !hasChanges && !isBehind && status.aheadCount > 0
      && (status.hasUpstream || canPushWithoutUpstream)
    let canCreatePR = !busy && hasBranch && !hasOpenPR && (status.aheadOfDefaultCount ?? status.aheadCount) > 0 && !isBehind
      && (status.hasUpstream || canPushWithoutUpstream)
    return [
      MenuItem(id: .commit, disabled: !canCommit, opensExisting: false),
      MenuItem(id: .push, disabled: !canPush, opensExisting: false),
      hasOpenPR
        ? MenuItem(id: .pr, disabled: busy, opensExisting: true)
        : MenuItem(id: .pr, disabled: !canCreatePR, opensExisting: false),
    ]
  }

  public enum QuickAction: Sendable, Hashable {
    case run(GitStackedAction)
    case pull
    case openPR
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
    let isDefault = status.isDefaultRef
    let hasOpenPR = status.openChangeRequest != nil
    let isAhead = status.aheadCount > 0
    let isBehind = status.behindCount > 0
    let hasDefaultDelta = (status.aheadOfDefaultCount ?? status.aheadCount) > 0
    guard status.refName != nil else { return .hint(.noBranch, labelAction: .commit) }
    if status.hasWorkingTreeChanges {
      if isBehind || (!status.hasUpstream && !status.hasPrimaryRemote) { return .run(.commit) }
      if hasOpenPR || isDefault { return .run(.commitPush) }
      return .run(.commitPushPR)
    }
    if !status.hasUpstream {
      if !status.hasPrimaryRemote {
        if hasOpenPR, !isAhead { return .openPR }
        return .hint(.noOriginRemote, labelAction: .push)
      }
      if !isAhead {
        if hasOpenPR { return .openPR }
        return .hint(.noLocalCommits, labelAction: .push)
      }
      return hasOpenPR || isDefault ? .run(.push) : .run(.createPR)
    }
    if isAhead, isBehind { return .hint(.diverged, labelAction: .sync) }
    if isBehind { return .pull }
    if isAhead { return hasOpenPR || isDefault ? .run(.push) : .run(.createPR) }
    if hasOpenPR { return .openPR }
    if hasDefaultDelta, !isDefault { return .run(.createPR) }
    return .hint(.upToDate, labelAction: .commit)
  }

  public enum DisabledReason: Sendable, Hashable {
    case inProgress, statusUnavailable
    case commitClean, commitUnavailable
    case pushDetached, pushDirty, pushBehind, pushNoOrigin, pushNothing, pushUnavailable
    case viewPRUnavailable, prDetached, prNoOrigin, prNothing, prBehind, prUnavailable
  }

  /// Why a disabled Git sheet row is disabled (`getGitActionDisabledReason`).
  public static func disabledReason(_ item: MenuItem, status: VcsStatus?, busy: Bool) -> DisabledReason? {
    guard item.disabled else { return nil }
    if busy { return .inProgress }
    guard let status else { return .statusUnavailable }
    let hasBranch = status.refName != nil
    let hasChanges = status.hasWorkingTreeChanges
    switch item.id {
    case .commit:
      return hasChanges ? .commitUnavailable : .commitClean
    case .push:
      if !hasBranch { return .pushDetached }
      if hasChanges { return .pushDirty }
      if status.behindCount > 0 { return .pushBehind }
      if !status.hasUpstream, !status.hasPrimaryRemote { return .pushNoOrigin }
      if status.aheadCount == 0 { return .pushNothing }
      return .pushUnavailable
    case .pr:
      if status.openChangeRequest != nil { return .viewPRUnavailable }
      if !hasBranch { return .prDetached }
      if !status.hasUpstream, !status.hasPrimaryRemote { return .prNoOrigin }
      if (status.aheadOfDefaultCount ?? status.aheadCount) <= 0 { return .prNothing }
      if status.behindCount > 0 { return .prBehind }
      return .prUnavailable
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

  /// The host's word for a change request: GitLab says merge request.
  public enum ChangeRequestTerm: Sendable, Hashable { case pr, mr }

  public static func term(_ status: VcsStatus?) -> ChangeRequestTerm {
    status?.sourceControlProvider?.kind == "gitlab" ? .mr : .pr
  }
}
