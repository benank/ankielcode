import AnkielKit
import SwiftUI

extension Palette {
  /// Pull request states keep the forge's hues, muted to the app's palette.
  static let prOpen = Color(light: 0x1F8A4C, dark: 0x45C07A)
  static let prMerged = Color(light: 0x7A4FD1, dark: 0xA98BF0)
  static let prClosed = Color(light: 0xC8302B, dark: 0xF0625C)
}

/// Words, symbols and tints for the pull request screens (RN `pullRequestStatus.ts`,
/// `pullRequestActions.ts`).
enum PullRequestCopy {
  // MARK: State

  static func state(_ state: PullRequestDisplayState) -> String {
    switch state {
    case .open: String(localized: "Open", comment: "pull request state")
    case .draft: String(localized: "Draft", comment: "pull request state")
    case .merged: String(localized: "Merged", comment: "pull request state")
    case .closed: String(localized: "Closed", comment: "pull request state")
    }
  }

  static func symbol(_ state: PullRequestDisplayState?) -> String {
    switch state {
    case .open?: "arrow.triangle.pull"
    case .draft?: "circle.dashed"
    case .merged?: "arrow.triangle.merge"
    case .closed?: "xmark.circle"
    case nil: "arrow.triangle.pull"
    }
  }

  static func tint(_ state: PullRequestDisplayState?) -> Color {
    switch state {
    case .open?: Palette.prOpen
    case .merged?: Palette.prMerged
    case .closed?: Palette.prClosed
    case .draft?, nil: Palette.textTertiary
    }
  }

  /// "#12 pull request open" for VoiceOver.
  static func accessibility(_ badge: ThreadPullRequestBadge) -> String {
    let state = badge.state.map(Self.state) ?? String(localized: "Status pending")
    switch badge.kind {
    case .single: return String(localized: "Pull request #\(badge.number), \(state)")
    case .stack(let layers): return String(localized: "\(layers) pull requests in stack, \(state)")
    case .several(let count): return String(localized: "\(count) linked pull requests, overall \(state)")
    }
  }

  // MARK: Checks

  static func checkStatus(_ status: WireEnum<PullRequestCheckStatus>) -> (label: String, symbol: String, tint: Color) {
    switch status.known {
    case .success?: (String(localized: "Passed", comment: "CI check status"), "checkmark.circle.fill", Palette.success)
    case .failure?: (String(localized: "Failed", comment: "CI check status"), "exclamationmark.circle.fill", Palette.danger)
    case .actionRequired?: (String(localized: "Action required", comment: "CI check status"), "exclamationmark.circle", Palette.attention)
    case .pending?: (String(localized: "Pending", comment: "CI check status"), "clock", Palette.textTertiary)
    case .cancelled?: (String(localized: "Cancelled", comment: "CI check status"), "minus.circle", Palette.textTertiary)
    case .skipped?: (String(localized: "Skipped", comment: "CI check status"), "slash.circle", Palette.textTertiary)
    case .neutral?, nil: (String(localized: "Neutral", comment: "CI check status"), "minus.circle", Palette.textTertiary)
    }
  }

  static func checksTitle(_ summary: PullRequestStatus.ChecksSummary) -> String {
    switch summary.state {
    case .failing: inflected("^[\(summary.failed) check](inflect: true) failing")
    case .attention: String(localized: "Checks need attention")
    case .pending: String(localized: "Checks running")
    case .passed: summary.passed == summary.total ? String(localized: "All checks passed") : String(localized: "Checks completed")
    case .completed: String(localized: "Checks completed")
    case .none: String(localized: "No checks reported")
    }
  }

  static func checksDetail(_ summary: PullRequestStatus.ChecksSummary) -> String? {
    switch summary.state {
    case .attention: String(localized: "\(summary.actionRequired) awaiting action")
    case .pending: String(localized: "\(summary.pending) pending")
    case .none: nil
    default: String(localized: "\(summary.passed) of \(summary.total)")
    }
  }

  static func checksSymbol(_ state: PullRequestStatus.ChecksTone) -> (String, Color) {
    switch state {
    case .failing: ("xmark.circle.fill", Palette.danger)
    case .attention: ("exclamationmark.circle", Palette.attention)
    case .pending: ("clock", Palette.textTertiary)
    case .passed: ("checkmark.circle.fill", Palette.success)
    case .completed, .none: ("minus.circle", Palette.textTertiary)
    }
  }

  static func checksState(_ state: PullRequestChecksState) -> (String, Color, String) {
    switch state {
    case .passing: ("checkmark.circle.fill", Palette.success, String(localized: "Checks passing"))
    case .failing: ("xmark.circle.fill", Palette.danger, String(localized: "Checks failing"))
    case .pending: ("clock", Palette.textTertiary, String(localized: "Checks running"))
    }
  }

  // MARK: Reviews

  static func reviewBadge(_ badge: PullRequestList.ReviewBadge) -> (label: String, accessible: String, symbol: String, tint: Color) {
    switch badge {
    case .changesRequested:
      (String(localized: "Changes", comment: "review status badge: changes requested"), String(localized: "Changes requested"), "person.fill.xmark", Palette.danger)
    case .approved:
      (String(localized: "Approved", comment: "review status badge"), String(localized: "Reviews approved"), "person.fill.checkmark", Palette.success)
    case .yourReview: (String(localized: "Your review"), String(localized: "Your review requested"), "person.badge.clock", Palette.attention)
    case .reviewRequired:
      (String(localized: "Review", comment: "review status badge: review required"), String(localized: "Review required"), "person.badge.clock", Palette.textTertiary)
    }
  }

  static func reviewTitle(_ tone: PullRequestStatus.ReviewTone) -> (title: String, detail: String, symbol: String, tint: Color) {
    switch tone {
    case .changesRequested(let count):
      (String(localized: "Changes requested"), inflected("^[\(count) reviewer](inflect: true)"), "xmark.circle.fill", Palette.danger)
    case .approved(let count, let by):
      (
        by.map { String(localized: "Approved by \($0)") } ?? String(localized: "Reviews approved"),
        String(localized: "\(count) approved"), "checkmark.circle.fill", Palette.success
      )
    case .commented(let count): (String(localized: "Reviews"), String(localized: "\(count) commented"), "bubble.left", Palette.textTertiary)
    case .awaiting(let requested): (String(localized: "Awaiting review"), String(localized: "\(requested) requested"), "person.2", Palette.textTertiary)
    case .none: (String(localized: "Request a review"), String(localized: "None assigned"), "person.2", Palette.textTertiary)
    }
  }

  static func reviewState(_ state: String) -> (String, String, Color) {
    switch state {
    case "APPROVED": (String(localized: "approved these changes"), "checkmark.circle.fill", Palette.success)
    case "CHANGES_REQUESTED": (String(localized: "requested changes"), "xmark.circle.fill", Palette.danger)
    case "DISMISSED": (String(localized: "review dismissed"), "minus.circle", Palette.textTertiary)
    default: (String(localized: "reviewed"), "eye", Palette.textTertiary)
    }
  }

  static func branch(_ tone: PullRequestStatus.BranchTone, base: String) -> String {
    switch tone {
    case .conflicts: String(localized: "Has conflicts")
    case .behind(let count?): String(localized: "\(count) behind \(base)")
    case .behind(nil): String(localized: "behind \(base)")
    case .upToDate: String(localized: "Up to date")
    case .noConflicts: String(localized: "No conflicts")
    case .unknown: String(localized: "Not reported")
    }
  }

  // MARK: Actions

  static func action(_ action: PullRequestAction) -> (String, String) {
    switch action {
    case .merge: (String(localized: "Merge pull request"), "arrow.triangle.merge")
    case .ready: (String(localized: "Mark ready for review"), "checkmark.circle")
    case .draft: (String(localized: "Convert to draft"), "pencil")
    case .close: (String(localized: "Close pull request"), "xmark")
    case .reopen: (String(localized: "Reopen pull request"), "arrow.clockwise")
    case .updateBranch: (String(localized: "Update branch"), "arrow.up.circle")
    case .enableAutoMerge: (String(localized: "Enable auto-merge"), "clock")
    case .disableAutoMerge: (String(localized: "Disable auto-merge"), "xmark")
    case .revert: (String(localized: "Create revert pull request"), "arrow.uturn.backward")
    case .deleteBranch: (String(localized: "Delete branch"), "trash")
    case .approveWorkflows: (String(localized: "Approve workflows"), "checkmark")
    }
  }

  static func merge(_ method: PullRequestMergeMethod) -> (title: String, detail: String) {
    switch method {
    case .squash: (String(localized: "Squash and merge"), String(localized: "Combine the commits into one commit."))
    case .merge: (String(localized: "Create a merge commit"), String(localized: "Keep the commits and add a merge commit."))
    case .rebase: (String(localized: "Rebase and merge"), String(localized: "Add the commits without a merge commit."))
    case .fastForward:
      (String(localized: "Fast-forward merge"), String(localized: "Add the commits as they are. Needs the branch to contain the base."))
    }
  }

  static func mergeBlock(_ block: PullRequestStatus.MergeBlock) -> String {
    switch block {
    case .merged: String(localized: "This pull request has been merged.")
    case .closed: String(localized: "Reopen this pull request before merging.")
    case .readOnly: String(localized: "This environment connection is read-only.")
    case .unsupported: String(localized: "This provider does not support merging here.")
    case .notAllowed: String(localized: "Your account cannot merge this pull request.")
    case .draft: String(localized: "Mark this draft ready for review before merging.")
    case .conflicts: String(localized: "Resolve the branch conflicts before merging.")
    case .noMethods: String(localized: "This repository has no available merge methods.")
    }
  }

  static func verdict(_ verdict: PullRequestReviewVerdict) -> (String, String) {
    switch verdict {
    case .comment: (String(localized: "Comment", comment: "review verdict"), "bubble.left")
    case .approve: (String(localized: "Approve", comment: "review verdict"), "checkmark.circle")
    case .requestChanges: (String(localized: "Request changes", comment: "review verdict"), "xmark.circle")
    }
  }

  // MARK: Errors

  static func error(_ error: PullRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "Reconnect to load pull requests that aren't saved on this device.")
    case .unavailable(let unavailable):
      switch unavailable.reason.known {
      case .cliMissing?: unavailable.requirement ?? String(localized: "The tool this host is read through is not installed or set up.")
      case .cliUnauthenticated?: unavailable.requirement ?? String(localized: "This host has no working credentials.")
      case .providerUnsupported?: String(localized: "Change requests cannot be browsed for this project's host yet.")
      case .repositoryWithoutProject?:
        if let host = unavailable.host {
          String(localized: "No project in Ankiel Code is on \(host). Add any \(host) project to read its change requests.")
        } else {
          missingProject(unavailable.repository)
        }
      case nil: unavailable.requirement ?? String(localized: "Pull requests are unavailable on this computer.")
      }
    case .operation(let detail, let notFound): notFound ? String(localized: "Pull request not found. \(detail)") : detail
    case .rejected(let message, _): message ?? String(localized: "The computer refused this request.")
    case .failed(let message): message
    }
  }

  static func missingProject(_ repository: String?) -> String {
    let name = repository ?? String(localized: "This repository")
    return String(localized: "\(name) is not a project in Ankiel Code. Add it as a project to read its change requests.")
  }

  static func signedOut(_ error: PullRequestError) -> Bool {
    if case .unavailable(let unavailable) = error, [.cliMissing, .cliUnauthenticated].contains(unavailable.reason.known) { return true }
    return false
  }
}

/// A label's dot in its own color.
struct PullRequestLabelDot: View {
  let label: PullRequestLabel

  var body: some View {
    HStack(spacing: Spacing.xs) {
      Circle()
        .fill(Self.color(label.color) ?? Palette.textTertiary)
        .frame(width: 7, height: 7)
      Text(verbatim: label.name)
        .lineLimit(1)
    }
    .font(Typography.caption)
    .foregroundStyle(Palette.textSecondary)
    .padding(.horizontal, Spacing.sm)
    .padding(.vertical, 3)
    .background(Palette.fill, in: .capsule)
  }

  static func color(_ hex: String?) -> Color? {
    guard let hex = PullRequestList.labelColor(hex), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return Color(uiColor: UIColor(rgb: value))
  }
}

/// `+12 −4` in diff colors.
struct PullRequestCounts: View {
  let additions: Int
  let deletions: Int

  var body: some View {
    HStack(spacing: Spacing.xs) {
      Text(verbatim: "+\(additions)").foregroundStyle(Palette.diffAdded)
      Text(verbatim: "−\(deletions)").foregroundStyle(Palette.diffRemoved)
    }
    .font(Typography.caption.monospacedDigit().weight(.medium))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text("\(additions) additions, \(deletions) deletions"))
  }
}

/// A person's initials in a circle (avatars are not loaded; the host's images need its auth).
struct PullRequestAvatar: View {
  let actor: PullRequestActor?
  var size: CGFloat = 22

  var body: some View {
    let login = actor?.login ?? "?"
    Text(verbatim: String(login.prefix(1)).uppercased())
      .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
      .foregroundStyle(Palette.textSecondary)
      .frame(width: size, height: size)
      .background(Palette.fill, in: .circle)
      .overlay {
        if actor?.isBot == true {
          Image(systemName: "gearshape.fill")
            .font(.system(size: size * 0.34))
            .foregroundStyle(Palette.textTertiary)
            .offset(x: size * 0.36, y: size * 0.36)
        }
      }
      .accessibilityHidden(true)
  }
}

/// A localized string whose `^[…](inflect: true)` markup is applied (plain `String(localized:)`
/// leaves the markup in place).
func inflected(_ key: LocalizedStringResource) -> String {
  String(AttributedString(localized: key).characters)
}
