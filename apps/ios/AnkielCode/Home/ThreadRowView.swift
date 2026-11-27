import AnkielKit
import SwiftUI

/// One thread row. Value-driven and `Equatable`, so a shell change re-renders only the rows whose
/// values changed. The relative time is a leaf that reads the shared minute clock.
struct ThreadRowView: View, Equatable {
  let row: ThreadRow
  let selected: Bool
  /// Opens the row's pull request chip.
  var openPullRequest: (ThreadPullRequestBadge) -> Void = { _ in }
  @Environment(\.dynamicTypeSize) private var typeSize

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row && lhs.selected == rhs.selected }

  var body: some View {
    // At accessibility sizes the status moves under the title instead of squeezing it to a word.
    let large = typeSize.isAccessibilitySize
    HStack(alignment: large ? .firstTextBaseline : .center, spacing: Spacing.md) {
      ThreadLightView(light: row.light, pinned: row.pinned && row.light == nil)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(row.title.isEmpty ? String(localized: "New thread") : row.title)
          .font(row.variant == .card ? Typography.body.weight(row.unread ? .semibold : .regular) : Typography.body)
          .foregroundStyle(row.variant == .slim ? Palette.textSecondary : Palette.textPrimary)
          .opacity(row.regeneratingTitle ? 0.55 : 1)
          .lineLimit(large ? 3 : 1)
        if let subtitle {
          Text(subtitle)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textTertiary)
            .lineLimit(row.searchHit == nil && !large ? 1 : 2)
        }
        if large {
          ThreadMetaView(row: row)
          pullRequestChip
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if !large {
        VStack(alignment: .trailing, spacing: Spacing.xs) {
          ThreadMetaView(row: row)
          pullRequestChip
        }
      }
    }
    .padding(.vertical, Spacing.sm)
    .padding(.leading, CGFloat(row.depth) * Spacing.lg)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
  }

  @ViewBuilder
  private var pullRequestChip: some View {
    if let badge = row.pullRequest {
      Button { openPullRequest(badge) } label: { ThreadPullRequestChip(badge: badge, compact: true) }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("thread.row.pullRequest")
    }
  }

  /// The project when the row is not under its folder, and the computer when several are saved;
  /// a message match replaces both.
  private var subtitle: String? {
    if let hit = row.searchHit { return hit.snippet }
    let parts = [row.inFolder || row.depth > 0 ? nil : row.projectTitle, row.environmentLabel].compactMap(\.self)
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private var accessibilityLabel: String {
    var parts = [row.title]
    if let label = row.statusLabel { parts.append(ThreadCopy.status(label)) }
    if row.snoozed, let wake = row.snoozeWakeAt { parts.append(ThreadCopy.wakes(at: wake)) }
    if let subtitle { parts.append(subtitle) }
    if row.pinned { parts.append(String(localized: "Pinned")) }
    if row.regeneratingTitle { parts.append(String(localized: "regenerating title")) }
    if let badge = row.pullRequest { parts.append(PullRequestCopy.accessibility(badge)) }
    return parts.joined(separator: ", ")
  }
}

/// The 16 pt slot before the title: the status light, else a pin. Always held open so a light
/// coming or going never shifts the title.
struct ThreadLightView: View {
  let light: ThreadLight?
  var pinned = false

  var body: some View {
    ZStack {
      if let light {
        Image(systemName: Self.symbol(light))
          .font(.system(size: Self.size(light), weight: .semibold))
          .foregroundStyle(Self.tint(light))
          .contentTransition(.symbolEffect(.replace))
          .motionTransition(.scale(scale: 0.4).combined(with: .opacity))
      } else if pinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Palette.textTertiary)
          .rotationEffect(.degrees(45))
      }
    }
    .frame(width: 16, height: 16)
    .motion(Motion.micro, value: light)
    .accessibilityHidden(true)
  }

  static func symbol(_ light: ThreadLight) -> String {
    switch light {
    case .working: "circle.dotted"
    case .waiting: "pause.circle"
    case .done: "circle.fill"
    case .failed: "exclamationmark.triangle.fill"
    case .attention: "circle.fill"
    }
  }

  static func size(_ light: ThreadLight) -> CGFloat {
    switch light {
    case .done, .attention: 9
    case .failed: 11
    case .working, .waiting: 13
    }
  }

  static func tint(_ light: ThreadLight) -> Color {
    switch light {
    case .working: Palette.working
    case .waiting: Palette.textTertiary
    case .done: Palette.working
    case .failed: Palette.danger
    case .attention: Palette.attention
    }
  }
}

/// The trailing meta: a status word, a snooze countdown, or the relative time.
private struct ThreadMetaView: View {
  let row: ThreadRow

  var body: some View {
    Group {
      if row.snoozed, let wake = row.snoozeWakeAt {
        SnoozeCountdownText(wake: wake)
      } else if let label = row.statusLabel, label != .working, label != .waiting {
        Text(ThreadCopy.status(label))
          .foregroundStyle(tint(label))
          .contentTransition(.opacity)
      } else if let time = row.timeAt {
        RelativeTimeText(date: time)
      }
    }
    .font(Typography.footnote.monospacedDigit())
    .foregroundStyle(Palette.textTertiary)
    .lineLimit(1)
    .fixedSize()
    .motion(Motion.micro, value: row.statusLabel)
  }

  private func tint(_ label: ThreadStatusLabel) -> Color {
    switch label {
    case .approval, .input, .limited, .woke: Palette.attention
    case .failed: Palette.danger
    case .done, .goal: Palette.working
    case .working, .waiting: Palette.textTertiary
    }
  }
}

/// A project's folder in the list: its name, and while closed a count and the most urgent light.
struct FolderHeaderRow: View {
  let folder: ProjectFolder

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Image(systemName: folder.collapsed ? "folder" : "folder.fill")
        .font(.system(size: 13))
        .foregroundStyle(Palette.textTertiary)
        .contentTransition(.symbolEffect(.replace))
        .frame(width: 16)
      Text(folder.title.isEmpty ? String(localized: "Project") : folder.title)
        .font(Typography.subheadline.weight(.semibold))
        .foregroundStyle(Palette.textSecondary)
        .lineLimit(1)
      Spacer(minLength: Spacing.sm)
      if folder.collapsed {
        if let light = folder.hiddenLight { ThreadLightView(light: light) }
        Text(folder.count, format: .number)
          .font(Typography.footnote.monospacedDigit())
          .foregroundStyle(Palette.textTertiary)
          .contentTransition(.numericText())
      }
      Image(systemName: "chevron.down")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Palette.textTertiary)
        .rotationEffect(.degrees(folder.collapsed ? -90 : 0))
    }
    .padding(.top, Spacing.md)
    .padding(.bottom, Spacing.xxs)
    .frame(minHeight: 44)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityValue(folder.collapsed ? Text("Collapsed") : Text("Expanded"))
    .accessibilityAddTraits(.isButton)
  }

  private var accessibilityLabel: String {
    let title = folder.title.isEmpty ? String(localized: "Project") : folder.title
    guard folder.collapsed, let light = folder.hiddenLight else { return title }
    return switch light {
    case .attention: String(localized: "\(title), needs you")
    case .failed: String(localized: "\(title), failed")
    case .done: String(localized: "\(title), done")
    case .working, .waiting: String(localized: "\(title), working")
    }
  }
}

/// The Snoozed and Settled shelf headers.
struct ShelfHeaderRow: View {
  let shelf: ThreadShelf
  let count: Int
  let expanded: Bool

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Text(shelf == .snoozed ? String(localized: "Snoozed") : String(localized: "Settled"))
        .font(Typography.subheadline.weight(.semibold))
        .foregroundStyle(Palette.textSecondary)
      Text(count, format: .number)
        .font(Typography.subheadline.monospacedDigit())
        .foregroundStyle(Palette.textTertiary)
        .contentTransition(.numericText())
      Spacer()
      Image(systemName: "chevron.down")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Palette.textTertiary)
        .rotationEffect(.degrees(expanded ? 0 : -90))
    }
    .padding(.top, Spacing.lg)
    .frame(minHeight: 44)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      shelf == .snoozed
        ? Text("^[\(count) snoozed thread](inflect: true)") : Text("^[\(count) settled thread](inflect: true)"))
    .accessibilityHint(
      expanded
        ? (shelf == .snoozed ? Text("Collapses the snoozed threads.") : Text("Collapses the settled threads."))
        : (shelf == .snoozed ? Text("Expands the snoozed threads.") : Text("Expands the settled threads.")))
    .accessibilityAddTraits(.isButton)
  }
}
