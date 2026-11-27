import AnkielKit
import SwiftUI

/// The conversation feed: identity-stable rows that open at the end, follow new content only while
/// the reader is at the end, offer a way back when they scroll up, and restore where they were when
/// they come back to the thread. Scrolling lives in `FeedCollection` and its rules in `FeedScroll`.
struct ThreadTimelineView: View {
  let model: ThreadDetailModel
  let images: ThreadImages
  let openThread: (String) -> Void
  /// Messages on their way to the server, after the server's rows.
  var pending: [PendingRow] = []
  /// Room after the last row for what floats over the feed's end (the request dock), so the
  /// newest row sits above it instead of under it.
  var trailingSpace: CGFloat = 0

  @State private var status = FeedStatus()
  @State private var insets = EdgeInsets()
  @Environment(AppModel.self) private var app
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Color.clear
      .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { insets = $0 }
      .overlay {
        // The whole pane scrolls under the bars and the composer; the feed insets itself by them.
        FeedCollection(
          items: items, revision: model.state.revision, model: model, images: images, openThread: openThread,
          status: status, insets: insets, trailingSpace: trailingSpace, app: app
        )
        .ignoresSafeArea()
      }
    .overlay(alignment: .bottom) {
      if !status.following, model.state.isLoaded {
        ScrollToLatestButton(unseen: status.unseen) {
          status.controller?.scrollToEnd(animated: true)
        }
        .padding(.bottom, Spacing.md + trailingSpace)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
      }
    }
    .motion(Motion.micro, value: status.following)
  }

  private var items: [FeedItem] {
    let laid = Self.layout(model.state.timeline.visibleRows(expanded: model.expanded))
    var items = laid.map { item in
      FeedItem.row(item.row, spacing: item.spacing, expanded: isExpanded(item.row), load: load(item.row))
    }
    for row in pending {
      items.append(.pending(row, spacing: laid.isEmpty && row.id == pending.first?.id ? 0 : Spacing.xxl))
    }
    return items
  }

  private func isExpanded(_ row: TimelineRow) -> Bool {
    switch row.content {
    case .fold(let fold): model.expanded.contains(fold.foldId)
    case .workGroup(let group): model.expanded.contains(group.groupId)
    default: model.expanded.contains(row.id)
    }
  }

  private func load(_ row: TimelineRow) -> ThreadDetailModel.DetailLoad? {
    guard case .work(let work) = row.content, model.expanded.contains(row.id) else { return nil }
    return model.detail(itemId: work.activity.itemId, revision: work.activity.revision)
  }

  struct Laid {
    var row: TimelineRow
    var spacing: CGFloat
  }

  /// Vertical rhythm: turns breathe, work rows sit tight, the reply sits close to its work.
  static func layout(_ rows: [TimelineRow]) -> [Laid] {
    var laid: [Laid] = []
    laid.reserveCapacity(rows.count)
    var previous: TimelineRow.Content?
    for row in rows {
      laid.append(Laid(row: row, spacing: previous.map { spacing(between: $0, and: row.content) } ?? 0))
      previous = row.content
    }
    return laid
  }

  static func spacing(between previous: TimelineRow.Content, and next: TimelineRow.Content) -> CGFloat {
    switch (previous, next) {
    case (_, .user): Spacing.xxl
    case (.user, _): Spacing.lg
    case (.work(let work), .work(let other)) where work.inGroup || other.inGroup: 0
    case (.workGroup, .work(let work)) where work.inGroup: 0
    case (.work, .work), (.work, .workGroup), (.workGroup, .work), (.workGroup, .workGroup), (.fold, .workGroup),
      (.fold, .work):
      Spacing.xxs
    case (.assistant, .assistant): Spacing.md
    case (_, .assistant): Spacing.sm
    case (.assistant, _): Spacing.md
    default: Spacing.sm
    }
  }
}

/// One row. Equatable on its data, so a streaming update re-renders only the rows that changed.
struct TimelineRowView: View, Equatable {
  let row: TimelineRow
  let expanded: Bool
  let load: ThreadDetailModel.DetailLoad?
  let images: ThreadImages
  let model: ThreadDetailModel
  let openThread: (String) -> Void
  let toggle: (String) -> Void

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.load == rhs.load && lhs.images == rhs.images
  }

  var body: some View {
    switch row.content {
    case .user(let message):
      UserMessageView(row: message, expanded: expanded, images: images) { toggle(row.id) }
    case .assistant(let message):
      AssistantMessageView(row: message, images: images)
    case .fold(let fold):
      RunFoldView(fold: fold, expanded: expanded) { toggle(fold.foldId) }
    case .workGroup(let group):
      WorkGroupView(group: group, expanded: expanded) { toggle(group.groupId) }
    case .work(let work):
      WorkRowView(row: work, expanded: expanded, load: load) {
        toggle(row.id)
      } loadDetail: {
        model.loadDetail(itemId: work.activity.itemId, revision: work.activity.revision)
      }
    case .subagent(let subagent):
      SubagentRowView(row: subagent, open: subagent.childThreadId.map { id in { openThread(id) } })
    case .plan(let plan):
      PlanRowView(row: plan)
    case .notice(let notice):
      NoticeRowView(row: notice)
    case .answered(let answered):
      AnsweredRowView(row: answered)
    case .working(let working):
      WorkingRowView(row: working)
    }
  }

}

/// The floating glass button back to the newest message; a dot says new content arrived.
private struct ScrollToLatestButton: View {
  let unseen: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.down")
        .font(Typography.subheadline.weight(.semibold))
        .foregroundStyle(Palette.textPrimary)
        .frame(width: 44, height: 44)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .glassEffect(.regular.interactive(), in: .circle)
    .overlay(alignment: .topTrailing) {
      if unseen {
        Circle()
          .fill(Palette.working)
          .frame(width: 10, height: 10)
          .offset(x: -2, y: 2)
          .motionTransition(.scale.combined(with: .opacity))
      }
    }
    .motion(Motion.micro, value: unseen)
    .accessibilityLabel(Text("Scroll to latest"))
    .accessibilityValue(unseen ? Text("New messages") : Text(""))
    .accessibilityIdentifier("thread.scrollToLatest")
  }
}

