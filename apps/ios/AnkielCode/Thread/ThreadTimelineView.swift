import AnkielKit
import SwiftUI

/// The conversation feed: a lazy stack of identity-stable rows that opens at the bottom, follows
/// new content only while the reader is at the bottom, offers a way back when they scroll up, and
/// restores where they were when they come back to the thread.
struct ThreadTimelineView: View {
  let model: ThreadDetailModel
  let images: ThreadImages
  let openThread: (String) -> Void
  /// Messages on their way to the server, after the server's rows.
  var pending: [PendingRow] = []
  /// Room after the last row for what floats over the feed's end (the request dock), so the
  /// newest row sits above it instead of under it.
  var trailingSpace: CGFloat = 0

  @State private var position: ScrollPosition
  @State private var atBottom: Bool
  @State private var unseen = false
  @State private var topVisible: String?
  /// Set while the reader opens or closes a row: it grows in place instead of the bottom anchor
  /// pushing it up out of view.
  @State private var holdingAnchor = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    model: ThreadDetailModel, images: ThreadImages, openThread: @escaping (String) -> Void,
    pending: [PendingRow] = [], trailingSpace: CGFloat = 0
  ) {
    self.model = model
    self.images = images
    self.openThread = openThread
    self.pending = pending
    self.trailingSpace = trailingSpace
    let anchor = model.scrollAnchor
    _position = State(initialValue: anchor.map { ScrollPosition(id: $0, anchor: .top) } ?? ScrollPosition(idType: String.self))
    _atBottom = State(initialValue: anchor == nil)
  }

  var body: some View {
    let laid = Self.layout(model.state.timeline.visibleRows(expanded: model.expanded))
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(laid, id: \.row.id) { item in
          TimelineRowView(
            row: item.row, expanded: isExpanded(item.row), load: load(item.row), images: images, model: model,
            openThread: openThread, toggle: toggle
          )
          .equatable()
          .padding(.top, item.spacing)
        }
        ForEach(pending) { row in
          PendingRowView(row: row)
            .padding(.top, laid.isEmpty && row.id == pending.first?.id ? 0 : Spacing.xxl)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
        // The feed's end, so following new content lands exactly where opening did (a row's
        // bottom edge would leave out this room and move the feed when the first update arrives).
        Color.clear.frame(height: Spacing.xl + trailingSpace).id(Self.endId)
      }
      .scrollTargetLayout()
      .padding(.horizontal, Spacing.lg + 2)
      .padding(.top, Spacing.sm)
      .frame(maxWidth: Layout.readingWidth)
      // Exactly the container's width: wider content would let bottom anchoring scroll sideways.
      .containerRelativeFrame(.horizontal)
    }
    // The whole pane scrolls (and carries the edge effects), not just the reading column.
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .defaultScrollAnchor(model.scrollAnchor == nil ? .bottom : .top)
    // The composer growing or the keyboard rising keeps the newest row in view, unless the reader
    // scrolled up. While a row opens or closes the top holds, so it grows in place instead of
    // being pushed up (nil would fall back to the anchor above).
    .defaultScrollAnchor(holdingAnchor ? .top : (atBottom ? .bottom : nil), for: .sizeChanges)
    .scrollPosition($position)
    .scrollDismissesKeyboard(.interactively)
    // Hard at the top: the title sits over long-form text, which the soft edge left legible under it.
    .scrollEdgeEffectStyle(.hard, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
    .onScrollGeometryChange(for: CGFloat.self) { geometry in
      // The visible rect runs under the bars; the composer's inset is not content.
      (geometry.contentSize.height - (geometry.visibleRect.maxY - geometry.contentInsets.bottom)).rounded()
    } action: { _, distance in
      // A Bool here missed its last change during the first anchoring; the distance always moves.
      let isAtBottom = distance <= 56
      guard isAtBottom != atBottom else { return }
      atBottom = isAtBottom
      if isAtBottom { unseen = false }
    }
    .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.05) { ids in
      topVisible = ids.first
    }
    .onChange(of: model.state.revision) { _, _ in
      if atBottom {
        scrollToLatest()
      } else {
        unseen = true
      }
    }
    .onChange(of: trailingSpace) { _, _ in
      if atBottom { scrollToLatest() }
    }
    .onChange(of: pending) { old, new in
      // A new message of the user's own always brings the feed to it; a status change (failed,
      // with its buttons) stays in view while the reader is at the bottom.
      if new.count > old.count {
        withMotion(Motion.transition, reduceMotion: reduceMotion) { scrollToLatest() }
        unseen = false
      } else if atBottom {
        withMotion(Motion.micro, reduceMotion: reduceMotion) { scrollToLatest() }
      }
    }
    .overlay(alignment: .bottom) {
      if !atBottom, model.state.isLoaded {
        ScrollToLatestButton(unseen: unseen) {
          withMotion(Motion.transition, reduceMotion: reduceMotion) { scrollToLatest() }
          unseen = false
        }
        .padding(.bottom, Spacing.md + trailingSpace)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
      }
    }
    .motion(Motion.micro, value: atBottom)
    .onDisappear {
      model.scrollAnchor = atBottom ? nil : topVisible
    }
    #if DEBUG
      .task {
        // `ANKIEL_DEBUG_THREAD_SCROLL=top`: start at the first row (screenshots of the scrolled-up state).
        guard ProcessInfo.processInfo.environment["ANKIEL_DEBUG_THREAD_SCROLL"] == "top" else { return }
        try? await Task.sleep(for: .milliseconds(600))
        if let first = model.state.timeline.visibleRows(expanded: model.expanded).first {
          position.scrollTo(id: first.id, anchor: .top)
        }
      }
    #endif
  }

  /// To the feed's end. (`scrollTo(edge: .bottom)` also moved the feed sideways and past its end
  /// on iOS 26.)
  static let endId = "timeline.end"

  private func scrollToLatest() {
    position.scrollTo(id: Self.endId, anchor: .bottom)
  }

  private func toggle(_ id: String) {
    holdingAnchor = true
    withMotion(Motion.snappy, reduceMotion: reduceMotion) { model.toggle(id) }
    Task {
      try? await Task.sleep(for: .milliseconds(500))
      holdingAnchor = false
    }
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
private struct TimelineRowView: View, Equatable {
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

