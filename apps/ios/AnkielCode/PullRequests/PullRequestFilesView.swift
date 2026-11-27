import AnkielKit
import SwiftUI

/// The lines an inline review comment covers.
struct PullRequestInlineTarget: Hashable, Identifiable {
  let path: String
  let oldPath: String?
  let position: PullRequestReviewPosition
  let start: PullRequestReviewPosition?
  let label: String
  let excerpt: String

  var id: String { "\(path)|\(position)|\(start.map { "\($0)" } ?? "")" }
}

/// Files changed, with counts, viewed marks and open threads.
struct PullRequestFilesList: View {
  let detail: PullRequestDetailModel
  let target: PullRequestTarget

  var body: some View {
    switch detail.diff {
    case .failed(let error):
      ContentUnavailableView {
        Label("Diff unavailable", systemImage: "exclamationmark.triangle")
      } description: {
        Text(PullRequestCopy.error(error))
      } actions: {
        Button("Reload changes") { Task { await detail.loadDiff(reset: true) } }.buttonStyle(.glass)
      }
    case .loaded(let files):
      list(files)
    default:
      ProgressView().frame(maxWidth: .infinity).padding(.vertical, Spacing.xxl).accessibilityLabel(Text("Loading changes"))
    }
  }

  @ViewBuilder
  private func list(_ files: [DiffFile]) -> some View {
    let tests = files.filter { PullRequestDiffs.isTest($0.path) }
    let shown = detail.hideTests ? files.filter { !PullRequestDiffs.isTest($0.path) } : files
    let viewed = detail.viewed
    let counts = PullRequestDiffs.threadCounts(detail.threads)
    @Bindable var detail = detail
    VStack(alignment: .leading, spacing: Spacing.sm) {
      HStack {
        Text("\(viewed.intersection(files.map(\.path)).count) of \(files.count) viewed")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .contentTransition(.numericText())
        Spacer()
        if !tests.isEmpty {
          Toggle(isOn: $detail.hideTests) {
            Text("Hide test files").font(Typography.footnote)
          }
          .toggleStyle(.button)
          .buttonStyle(.glass)
          .controlSize(.small)
        }
      }
      if detail.hideTests, !tests.isEmpty {
        Text("^[\(tests.count) test](inflect: true) hidden").font(Typography.caption).foregroundStyle(Palette.textTertiary)
      }
      if shown.isEmpty {
        ContentUnavailableView {
          Label("Only test files changed", systemImage: "checklist")
        } description: {
          Text("Test files are hidden from this review.")
        } actions: {
          Button("Show test files") { detail.hideTests = false }.buttonStyle(.glass)
        }
      }
      VStack(spacing: 0) {
        ForEach(shown) { file in
          NavigationLink(value: PullRequestRoute.file(target, path: file.path)) {
            PullRequestFileRow(file: file, viewed: viewed.contains(file.path), threads: counts[file.path] ?? 0)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("pr.file.\(file.path)")
          if file.id != shown.last?.id { Divider().overlay(Palette.separator).padding(.leading, 40) }
        }
      }
      .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
      if detail.diffMore {
        Button("Load the remaining files") { Task { await detail.loadMoreDiff() } }
          .buttonStyle(.glass)
          .frame(maxWidth: .infinity)
          .accessibilityLabel(Text("Retry loading remaining files"))
      } else if detail.diffTruncated {
        Text("Some files are too large to show here.").font(Typography.footnote).foregroundStyle(Palette.textTertiary)
      }
    }
  }
}

struct PullRequestFileRow: View {
  let file: DiffFile
  let viewed: Bool
  let threads: Int

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: viewed ? "checkmark.circle.fill" : ReviewCopy.statusSymbol(file.status))
        .foregroundStyle(viewed ? Palette.success : FileStatusTint.color(file.status))
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: (file.path as NSString).lastPathComponent)
          .font(Typography.subheadline.weight(.medium))
          .foregroundStyle(viewed ? Palette.textSecondary : Palette.textPrimary)
          .lineLimit(1)
        let directory = (file.path as NSString).deletingLastPathComponent
        if !directory.isEmpty {
          Text(verbatim: directory).font(Typography.caption).foregroundStyle(Palette.textTertiary).lineLimit(1).truncationMode(.head)
        }
      }
      Spacer(minLength: Spacing.sm)
      if threads > 0 {
        Label("\(threads)", systemImage: "text.bubble").font(Typography.caption).foregroundStyle(Palette.working)
          .accessibilityLabel(Text("^[\(threads) open thread](inflect: true)"))
      }
      if file.additions + file.deletions > 0 { PullRequestCounts(additions: file.additions, deletions: file.deletions) }
      Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.textTertiary)
    }
    .padding(.horizontal, Spacing.md)
    .frame(minHeight: 52)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityValue(viewed ? Text("Viewed") : Text(""))
  }
}

/// One file's diff with its review threads and pending comments under their lines.
struct PullRequestFileScreen: View {
  let detail: PullRequestDetailModel
  @State var path: String
  @Environment(\.codeAppearance) private var code
  @State private var rows: [DiffRow] = []
  @State private var columns = 0
  @State private var built: String?
  @State private var revealed = false
  @State private var pending: DiffRow?
  @State private var sheet: PullRequestSheet?
  @State private var wrapOverride: Bool?
  @State private var alert: String?
  @Environment(AppModel.self) private var model

  private var files: [DiffFile] { detail.diff.value ?? [] }
  private var file: DiffFile? { files.first { $0.path == path } }
  private var wraps: Bool { wrapOverride ?? code.wraps }
  private var permissions: PullRequestPermissions {
    PullRequestPermissions(
      detail: detail.value, connected: model.pullRequests.isConnected(detail.environmentId),
      sourceControlWrite: model.pullRequests.canWrite(detail.environmentId))
  }

  var body: some View {
    Group {
      if let file {
        content(file)
      } else {
        ContentUnavailableView("No file selected", systemImage: "doc.text")
      }
    }
    .background(Palette.canvas)
    .navigationTitle(Text(verbatim: (path as NSString).lastPathComponent))
    .navigationSubtitle(Text(verbatim: (path as NSString).deletingLastPathComponent))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .sheet(item: $sheet) { sheet in
      PullRequestSheetView(sheet: sheet, detail: detail, permissions: permissions) { error in
        if let error { alert = PullRequestCopy.error(error) }
        pending = nil
      }
    }
    .alert("Couldn't send", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(verbatim: alert ?? "")
    }
    .sensoryFeedback(.selection, trigger: path)
  }

  @ViewBuilder
  private func content(_ file: DiffFile) -> some View {
    if file.isBinary {
      ContentUnavailableView("Non-text file", systemImage: "doc.richtext", description: Text("Diff preview is not available for this file format."))
    } else if file.hunks.isEmpty {
      ContentUnavailableView("No changes", systemImage: "doc.text", description: Text(file.previousPath.map { "\($0) → \(file.path)" } ?? ""))
    } else if (DiffFileOrder.isGenerated(file.path) || file.lineCount > 400) && !revealed {
      ContentUnavailableView {
        Label(DiffFileOrder.isGenerated(file.path) ? String(localized: "Generated file") : String(localized: "Large diff"), systemImage: "doc.text.magnifyingglass")
      } description: {
        Text("Large diffs are not rendered by default.")
      } actions: {
        Button("Load diff") { revealed = true }.buttonStyle(.glassProminent)
      }
    } else {
      let placement = PullRequestDiffs.place(threads: detail.threads, drafts: detail.reviewDrafts, path: file.path, rows: rows)
      VStack(spacing: 0) {
        if !placement.fileLevel.isEmpty {
          ForEach(placement.fileLevel) { note in
            Button { open(note) } label: { annotationLabel(note) }
              .buttonStyle(.plain)
              .padding(.horizontal, Spacing.lg)
              .padding(.top, Spacing.sm)
          }
        }
        ZStack(alignment: .bottom) {
          if built == key(file) {
            DiffLinesView(
              rows: rows, language: DiffText.language(file.path), columns: columns, wraps: wraps, expandable: false, expanding: false,
              selected: pending.map { [$0.id] } ?? [], onLine: { row, gesture in line(row, gesture: gesture, file: file) }, onExpand: { _ in },
              annotations: placement.byRow.mapValues { $0.map(annotation) }, onAnnotation: { note in
                if let found = placement.byRow.values.joined().first(where: { $0.id == note.id }) { open(found) }
              })
          } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
          }
          selectionBar(file)
        }
      }
      .task(id: key(file)) {
        let built = await BuiltRows.build(file, key: .init(fileId: file.id, section: "pr", expanded: [], contents: nil, expandable: false), contents: nil)
        rows = built.rows
        columns = built.columns
        self.built = key(file)
      }
    }
  }

  private func key(_ file: DiffFile) -> String { "\(file.id)|\(file.lineCount)" }

  private func annotation(_ note: PullRequestDiffs.Note) -> DiffAnnotation {
    switch note.kind {
    case .thread(let thread):
      let first = thread.comments.first
      return DiffAnnotation(
        id: note.id, title: first?.author?.login ?? String(localized: "Discussion"), body: first?.body ?? "",
        footnote: thread.isResolved
          ? inflected("Resolved · ^[\(thread.commentCount ?? thread.comments.count) comment](inflect: true)")
          : inflected("^[\(thread.commentCount ?? thread.comments.count) comment](inflect: true) · Tap to open"),
        tone: thread.isResolved ? .resolved : .thread)
    case .draft(let draft):
      return DiffAnnotation(id: note.id, title: String(localized: "Pending review"), body: draft.body, footnote: String(localized: "Tap to edit"), tone: .pending)
    }
  }

  private func annotationLabel(_ note: PullRequestDiffs.Note) -> some View {
    let model = annotation(note)
    return HStack(alignment: .top, spacing: Spacing.sm) {
      Image(systemName: "text.bubble").foregroundStyle(Palette.working)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: model.title).font(Typography.footnote.weight(.semibold))
        Text(verbatim: model.body).font(Typography.footnote).lineLimit(2)
        Text(verbatim: model.footnote).font(Typography.caption).foregroundStyle(Palette.textTertiary)
      }
      Spacer(minLength: 0)
    }
    .padding(Spacing.md)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
  }

  private func open(_ note: PullRequestDiffs.Note) {
    switch note.kind {
    case .thread(let thread): sheet = .thread(thread)
    case .draft(let draft):
      sheet = .inline(
        PullRequestInlineTarget(path: draft.path, oldPath: draft.oldPath, position: draft.position, start: draft.startPosition, label: Self.label(draft.position), excerpt: draft.body))
    }
  }

  static func label(_ position: PullRequestReviewPosition) -> String {
    let anchor = position.anchor
    return anchor.side == .left ? String(localized: "Old line \(anchor.line)") : String(localized: "Line \(anchor.line)")
  }

  /// A tap comments on a line; a long press starts a range, ended by the next tap.
  private func line(_ row: DiffRow, gesture: DiffLineGesture, file: DiffFile) {
    guard permissions.canInlineComment, let line = row.line, let position = PullRequestReviewPosition(line) else { return }
    switch gesture {
    case .longPress where detail.value?.capabilities.review.rangeComment == true:
      Haptics.selection()
      pending = row
    default:
      var start: PullRequestReviewPosition?
      if let pending, pending.id != row.id, let first = pending.line.flatMap(PullRequestReviewPosition.init) { start = first }
      sheet = .inline(
        PullRequestInlineTarget(
          path: file.path, oldPath: file.previousPath, position: position, start: start,
          label: start.map { "\(Self.label($0)) – \(Self.label(position))" } ?? Self.label(position), excerpt: line.text))
      pending = nil
    }
  }

  @ViewBuilder
  private func selectionBar(_ file: DiffFile) -> some View {
    if pending != nil {
      HStack {
        Text("Tap the last line of the range").font(Typography.footnote.weight(.medium))
        Spacer()
        Button("Cancel") { pending = nil }
      }
      .padding(.horizontal, Spacing.lg)
      .frame(minHeight: 44)
      .chromeGlass()
      .padding(Spacing.md)
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      let viewed = detail.viewed.contains(path)
      if permissions.canWrite {
        Button {
          Task { if let error = await detail.setViewed(path, !viewed) { alert = PullRequestCopy.error(error) } }
        } label: {
          Label(viewed ? String(localized: "Viewed") : String(localized: "Mark as viewed"), systemImage: viewed ? "checkmark.circle.fill" : "circle")
        }
        .accessibilityIdentifier("pr.file.viewed")
      }
      Menu {
        Button(wraps ? String(localized: "Don't wrap lines") : String(localized: "Word wrap"), systemImage: "text.word.spacing") { wrapOverride = !wraps }
        if let index = files.firstIndex(where: { $0.path == path }) {
          if index > 0 { Button("Previous file", systemImage: "chevron.up") { path = files[index - 1].path } }
          if index + 1 < files.count { Button("Next file", systemImage: "chevron.down") { path = files[index + 1].path } }
        }
        Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
      } label: {
        Label("Diff options", systemImage: "ellipsis")
      }
    }
  }
}
