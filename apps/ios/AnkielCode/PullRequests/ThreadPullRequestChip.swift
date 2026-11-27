import AnkielKit
import SwiftUI

/// A thread's pull request: state glyph, number (or stack count) and its checks.
struct ThreadPullRequestChip: View {
  let badge: ThreadPullRequestBadge
  var compact = false

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: PullRequestCopy.symbol(badge.state))
        .font(.system(size: compact ? 10 : 11, weight: .semibold))
        .foregroundStyle(PullRequestCopy.tint(badge.state))
      Text(verbatim: badge.label)
        .font((compact ? Typography.caption2 : Typography.caption).monospacedDigit().weight(.semibold))
        .foregroundStyle(badge.state == .draft || badge.state == nil ? Palette.textSecondary : PullRequestCopy.tint(badge.state))
      if let checks = badge.checks {
        let (symbol, tint, _) = PullRequestCopy.checksState(checks)
        Image(systemName: symbol)
          .font(.system(size: compact ? 9 : 10, weight: .semibold))
          .foregroundStyle(tint)
      }
    }
    .padding(.horizontal, compact ? 6 : Spacing.sm)
    .padding(.vertical, compact ? 2 : 4)
    .background(PullRequestCopy.tint(badge.state).opacity(0.12), in: .capsule)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: accessibility))
  }

  private var accessibility: String {
    var label = PullRequestCopy.accessibility(badge)
    if let checks = badge.checks { label += ", " + PullRequestCopy.checksState(checks).2 }
    return label
  }
}

/// The thread header's pull request button (shown only when the thread has one).
struct ThreadPullRequestToolbarButton: View {
  let threadRef: ThreadRef
  @Environment(AppModel.self) private var model

  var body: some View {
    let thread = model.home.thread(threadRef)
    let feature = model.pullRequests
    if let badge = feature.badge(for: thread, environmentId: threadRef.environmentId), let thread {
      Button {
        feature.open(badge, thread: thread, environmentId: threadRef.environmentId)
      } label: {
        ThreadPullRequestChip(badge: badge).fixedSize()
      }
      .buttonStyle(.plain)
      .accessibilityHint(Text("Opens the pull request"))
      .accessibilityIdentifier("thread.pullRequest")
    }
  }
}
