import AnkielKit
import SwiftUI

/// One file's diff, with previous and next, the file jump sheet, the viewed mark, wrapping, and
/// line comments that go to the thread's composer.
struct FileDiffScreen: View {
  let presenter: ReviewPresenter
  let files: [ReviewFile]
  @Binding var fileId: String?
  @Environment(\.codeAppearance) private var code
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var wrapOverride: Bool?
  @State private var jumping = false
  @State private var revealed: Set<String> = []
  @State private var built: BuiltRows?
  @State private var pending: PendingLine?
  @State private var range: ReviewCommentTarget?
  @State private var commenting: CommentDraft?
  @State private var viewedCount = 0
  /// The full file in the source viewer, pushed in review's own stack.
  @State private var opening: String?

  private var review: ReviewModel { presenter.review }
  private var index: Int? { files.firstIndex { $0.id == fileId } }
  private var file: ReviewFile? { index.map { files[$0] } }
  private var wraps: Bool { wrapOverride ?? code.wraps }

  var body: some View {
    Group {
      if let file {
        content(file)
          .id(file.id)
      } else {
        ContentUnavailableView("No file selected", systemImage: "doc.text")
      }
    }
    .background(Palette.canvas)
    .navigationTitle(file?.name ?? "")
    .navigationSubtitle(file.map(subtitle) ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .sheet(isPresented: $jumping) {
      FileJumpSheet(review: review, files: files, current: fileId) { id in
        select(id)
        jumping = false
      }
    }
    .sheet(item: $commenting) { draft in
      ReviewCommentSheet(target: draft.target, threadRef: presenter.ref) {
        range = nil
        pending = nil
      }
    }
    .navigationDestination(item: $opening) { path in
      if let files = presenter.files { FilePreviewView(target: .workspace(path: path, line: nil), presenter: files) }
    }
    .sensoryFeedback(.selection, trigger: fileId)
    .sensoryFeedback(.success, trigger: viewedCount)
    .onChange(of: fileId) { _, _ in
      pending = nil
      range = nil
    }
  }

  private func subtitle(_ file: ReviewFile) -> String {
    [file.directory, ReviewCopy.status(file.status)].compactMap { $0 }.joined(separator: " · ")
  }

  // MARK: Content

  @ViewBuilder
  private func content(_ file: ReviewFile) -> some View {
    VStack(spacing: 0) {
      FileHeader(file: file, viewed: review.isViewed(file))
      switch review.patch(file) {
      case .loading:
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel(Text("Loading diff…"))
          .onAppear { review.loadPatch(file) }
      case .failed(.tooLarge):
        placeholder(
          title: "File preview exceeds the size limit", message: "Counts include all changes.", symbol: "doc.text.magnifyingglass",
          action: nil)
      case .failed(let failure):
        placeholder(
          title: "Could not load diff", message: LocalizedStringKey(ReviewCopy.failure(failure)), symbol: "exclamationmark.triangle",
          action: ("Try again", { review.loadPatch(file) }))
      case .loaded(let diff):
        loaded(diff, file: file)
      }
    }
    .simultaneousGesture(swipe, including: wraps ? .all : .subviews)
  }

  @ViewBuilder
  private func loaded(_ diff: DiffFile, file: ReviewFile) -> some View {
    if diff.isBinary {
      placeholder(
        title: "Non-text file", message: "Diff preview is not available for this file format.", symbol: "doc.richtext", action: nil)
    } else if diff.hunks.isEmpty {
      placeholder(title: emptyTitle(diff), message: emptyMessage(diff), symbol: "doc.text", action: nil)
    } else if let reason = suppression(diff), !revealed.contains(file.id) {
      placeholder(
        title: reason.title, message: reason.message, symbol: reason.symbol,
        action: ("Load diff", { revealed.insert(file.id) }))
    } else {
      let key = BuiltRows.Key(
        fileId: diff.id, section: review.selectedId?.rawValue ?? "", expanded: review.expandedGaps(file),
        contents: review.fileContents(file)?.value?.count, expandable: review.canExpand)
      ZStack(alignment: .bottom) {
        if let built, built.key == key {
          DiffLinesView(
            rows: built.rows, language: DiffText.language(diff.path), columns: built.columns, wraps: wraps,
            expandable: review.canExpand, expanding: review.fileContents(file) == .loading, selected: selectedRows(built.rows),
            onLine: { row, gesture in line(row, gesture: gesture, rows: built.rows, file: file) },
            onExpand: { gap in review.expand(gap.index, in: file) })
        } else {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        selectionBar
      }
      .overlay(alignment: .top) { contentsFailure(file) }
      .onAppear {
        if ReviewDebug.expandAll, review.canExpand { for gap in 0...diff.hunks.count { review.expand(gap, in: file) } }
      }
      .task(id: key) {
        let lines = review.fileContents(file)?.value
        built = await BuiltRows.build(diff, key: key, contents: lines)
      }
    }
  }

  @ViewBuilder
  private func contentsFailure(_ file: ReviewFile) -> some View {
    if case .failed(let failure)? = review.fileContents(file) {
      StatusPill(text: LocalizedStringKey(ReviewCopy.failure(failure)), systemImage: "exclamationmark.triangle", tint: Palette.attention)
        .padding(.top, Spacing.sm)
    }
  }

  private func emptyTitle(_ diff: DiffFile) -> LocalizedStringKey {
    if diff.modeChanged { return "File mode changed" }
    if diff.status == .renamed { return "Renamed without changes" }
    return "No changes"
  }

  private func emptyMessage(_ diff: DiffFile) -> LocalizedStringKey {
    if diff.modeChanged { return "\(diff.oldMode ?? "") → \(diff.newMode ?? "")" }
    if let previous = diff.previousPath { return "\(previous) → \(diff.path)" }
    return "This diff is empty."
  }

  /// Large and generated files wait for a tap (RN `getReviewFilePreviewState`; generated is ours).
  private func suppression(_ diff: DiffFile) -> (title: LocalizedStringKey, message: LocalizedStringKey, symbol: String)? {
    if DiffFileOrder.isGenerated(diff.path) {
      return ("Generated file", "Lock files, build output and snapshots are folded.", "gearshape.2")
    }
    let characters = diff.hunks.reduce(0) { total, hunk in total + hunk.lines.reduce(0) { $0 + $1.text.utf8.count } }
    if diff.lineCount > 400 || characters > 24_000 {
      return ("Large diff", "Large diffs are not rendered by default.", "doc.text.magnifyingglass")
    }
    return nil
  }

  private func placeholder(
    title: LocalizedStringKey, message: LocalizedStringKey, symbol: String, action: (LocalizedStringKey, () -> Void)?
  ) -> some View {
    ContentUnavailableView {
      Label(title, systemImage: symbol)
    } description: {
      Text(message)
    } actions: {
      if let action {
        Button(action.0, action: action.1)
          .buttonStyle(.glassProminent)
          .accessibilityIdentifier("review.loadAnyway")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: Comments

  private struct PendingLine: Equatable {
    var rowId: String
    var index: Int
  }

  struct CommentDraft: Identifiable {
    let id = UUID()
    let target: ReviewCommentTarget
  }

  private func selectedRows(_ rows: [DiffRow]) -> Set<String> {
    if let range {
      let lines = rows.filter { $0.line != nil }
      guard range.startIndex < lines.count else { return [] }
      return Set(lines[range.startIndex...min(range.endIndex, lines.count - 1)].map(\.id))
    }
    return pending.map { [$0.rowId] } ?? []
  }

  private func line(_ row: DiffRow, gesture: DiffLineGesture, rows: [DiffRow], file: ReviewFile) {
    let lines = rows.filter { $0.line != nil }
    guard let index = lines.firstIndex(where: { $0.id == row.id }) else { return }
    switch gesture {
    case .longPress:
      Haptics.selection()
      range = nil
      pending = PendingLine(rowId: row.id, index: index)
    case .tap:
      if let pending {
        range = target(lines, from: pending.index, to: index, file: file)
        self.pending = nil
      } else {
        commenting = CommentDraft(target: target(lines, from: index, to: index, file: file))
      }
    }
  }

  private func target(_ lines: [DiffRow], from: Int, to: Int, file: ReviewFile) -> ReviewCommentTarget {
    let start = min(from, to)
    let end = max(from, to)
    let section = review.selectedId
    return ReviewCommentTarget(
      sectionId: section?.rawValue ?? "", sectionTitle: section.map(ReviewCopy.title) ?? String(localized: "Review"),
      filePath: file.path, lines: lines[start...end].compactMap(\.line), startIndex: start, endIndex: end)
  }

  @ViewBuilder
  private var selectionBar: some View {
    if range != nil || pending != nil {
      HStack(spacing: Spacing.sm) {
        Button {
          if let range { commenting = CommentDraft(target: range) }
        } label: {
          Label {
            if let range {
              Text("Comment on \(range.rangeLabel)")
            } else {
              Text("Select range end")
            }
          } icon: {
            Image(systemName: range != nil ? "text.bubble" : "line.3.horizontal.decrease.circle")
          }
          .font(Typography.subheadline.weight(.semibold))
          .foregroundStyle(Palette.onAccent)
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glassProminent)
        .disabled(range == nil)
        .accessibilityIdentifier("review.commentRange")
        Button {
          range = nil
          pending = nil
        } label: {
          Image(systemName: "xmark").frame(width: 44, height: 44)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(Text("Clear selection"))
      }
      .padding(.horizontal, Spacing.lg)
      .padding(.bottom, Spacing.sm)
      .motionTransition(.move(edge: .bottom).combined(with: .opacity))
    }
  }

  // MARK: Navigation

  private var swipe: some Gesture {
    DragGesture(minimumDistance: 40)
      .onEnded { value in
        guard abs(value.translation.width) > 90, abs(value.translation.height) < 60 else { return }
        step(value.translation.width < 0 ? 1 : -1)
      }
  }

  private func step(_ delta: Int) {
    guard let index, files.indices.contains(index + delta) else { return }
    select(files[index + delta].id)
  }

  private func select(_ id: String) {
    withMotion(Motion.transition, reduceMotion: reduceMotion) { fileId = id }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    if let file {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          let wasViewed = review.isViewed(file)
          review.toggleViewed(file)
          if !wasViewed {
            viewedCount += 1
            // Viewing moves on to the next file, like collapsing it does in RN's list.
            step(1)
          }
        } label: {
          Label(review.isViewed(file) ? "Viewed" : "Mark as viewed", systemImage: review.isViewed(file) ? "checkmark.circle.fill" : "circle")
            .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityValue(review.isViewed(file) ? Text("Viewed") : Text("Not viewed"))
        .accessibilityIdentifier("review.viewed")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Toggle(isOn: Binding(get: { wraps }, set: { wrapOverride = $0 })) {
            Label("Wrap lines", systemImage: "text.word.spacing")
          }
          .accessibilityIdentifier("review.wrap")
          if file.status != .deleted, presenter.files?.canBrowse == true {
            Button("Open file", systemImage: "doc.text.magnifyingglass") { opening = file.path }
              .accessibilityIdentifier("review.openFile")
          }
        } label: {
          Label("Diff options", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("review.fileMenu")
      }
      ToolbarItemGroup(placement: .bottomBar) {
        Button {
          step(-1)
        } label: {
          Label("Previous file", systemImage: "chevron.up")
        }
        .disabled((index ?? 0) == 0)
        .accessibilityIdentifier("review.previous")
        Spacer()
        Button {
          jumping = true
        } label: {
          Text("\((index ?? 0) + 1) of \(files.count)")
            .font(Typography.subheadline.monospacedDigit().weight(.medium))
            .contentTransition(.numericText())
        }
        .accessibilityLabel(Text("Files"))
        .accessibilityValue(Text("\((index ?? 0) + 1) of \(files.count)"))
        .accessibilityIdentifier("review.jump")
        Spacer()
        Button {
          step(1)
        } label: {
          Label("Next file", systemImage: "chevron.down")
        }
        .disabled((index ?? 0) >= files.count - 1)
        .accessibilityIdentifier("review.next")
      }
    }
  }
}

/// Built rows for one file state, made off the main actor (word diffs on big files take a moment).
struct BuiltRows: Equatable {
  struct Key: Hashable {
    var fileId: String
    var section: String
    var expanded: Set<Int>
    var contents: Int?
    var expandable: Bool
  }

  let key: Key
  let rows: [DiffRow]
  let columns: Int

  @concurrent
  static func build(_ diff: DiffFile, key: Key, contents: [String]?) async -> BuiltRows {
    let rows = DiffRows.build(diff, contents: contents, expanded: key.expanded, expandable: key.expandable)
    return BuiltRows(key: key, rows: rows, columns: DiffText.columns(rows))
  }
}

/// The file's path, status and counts above its diff.
private struct FileHeader: View {
  let file: ReviewFile
  let viewed: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(spacing: Spacing.sm) {
        Image(systemName: ReviewCopy.statusSymbol(file.status))
          .foregroundStyle(FileStatusTint.color(file.status))
        Text(verbatim: file.path)
          .font(Typography.monoSmall)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
          .truncationMode(.middle)
          .textSelection(.enabled)
        Spacer(minLength: Spacing.sm)
        if file.additions + file.deletions > 0 { DiffCounts(additions: file.additions, deletions: file.deletions) }
      }
      if let previous = file.previousPath {
        Text("Renamed from \(previous)")
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.vertical, Spacing.sm)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.separator).frame(height: 0.5) }
    .accessibilityElement(children: .combine)
  }
}

enum FileStatusTint {
  static func color(_ status: DiffFile.Status) -> Color {
    switch status {
    case .added: Palette.diffAdded
    case .deleted: Palette.diffRemoved
    case .renamed, .copied: Palette.working
    case .modified: Palette.textSecondary
    }
  }
}
