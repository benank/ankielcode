import AnkielKit
import SwiftUI

/// Review changes (RN `ReviewSheet`): a section (a turn, uncommitted changes, or the branch
/// against its base) and its changed files; a file opens its diff. On a wide screen the files
/// and the diff sit side by side.
struct ReviewScreen: View {
  let presenter: ReviewPresenter
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(AppModel.self) private var model
  @State private var path: [String] = []
  @State private var splitSelection: String?
  @State private var hideTests = false
  @State private var showsGit = false
  @State private var confirming: GitStackedAction?

  private var review: ReviewModel { presenter.review }

  private var allFiles: [ReviewFile] { review.selectedDiff?.value?.files ?? [] }
  private var files: [ReviewFile] { hideTests ? allFiles.filter { !DiffFileOrder.isTest($0.path) } : allFiles }

  var body: some View {
    Group {
      if sizeClass == .regular {
        NavigationSplitView {
          list(selection: $splitSelection)
        } detail: {
          NavigationStack {
            FileDiffScreen(presenter: presenter, files: files, fileId: $splitSelection)
          }
        }
      } else {
        NavigationStack(path: $path) {
          list(selection: nil)
            .navigationDestination(for: String.self) { id in
              FileDiffRoute(presenter: presenter, files: files, initial: id)
            }
        }
      }
    }
    .gitProgressToast(presenter.git)
    .sheet(isPresented: $showsGit) { GitSheet(presenter: presenter) }
    .onAppear { review.load() }
    // Turns arrive with the thread's stream, possibly after review opened.
    .onChange(of: review.selectedId) { _, _ in review.load() }
    .onChange(of: files.map(\.id), initial: true) { _, ids in
      openPending(ids)
      // The split's detail shows the first file rather than an empty pane.
      if sizeClass == .regular, splitSelection.map(ids.contains) != true { splitSelection = ids.first }
    }
  }

  /// A feed row asked for one file: open it once the section's files are in.
  private func openPending(_ ids: [String]) {
    // Feed rows can name a file by its absolute path.
    guard let pending = presenter.pendingPath,
      let file = files.first(where: { $0.path == pending || pending.hasSuffix("/\($0.path)") })
    else { return }
    presenter.pendingPath = nil
    if sizeClass == .regular { splitSelection = file.id } else { path = [file.id] }
  }

  // MARK: List

  private func list(selection: Binding<String?>?) -> some View {
    content(selection: selection)
      .navigationTitle(review.selectedId.map(ReviewCopy.title) ?? String(localized: "Review changes"))
      .navigationSubtitle(subtitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .refreshable { await review.refresh() }
  }

  private var subtitle: String {
    var parts: [String] = []
    if let diff = review.selectedDiff?.value, !diff.files.isEmpty {
      parts.append(String(localized: "\(diff.files.count) files"))
      parts.append("+\(diff.additions) −\(diff.deletions)")
    }
    let comments = ReviewCommentTarget.count(in: model.composer.draft(presenter.ref.key).text)
    if comments > 0 { parts.append(String(localized: "\(comments) comments")) }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder
  private func content(selection: Binding<String?>?) -> some View {
    if review.sections.isEmpty {
      if !presenter.connected, presenter.review.turns.isEmpty {
        ContentUnavailableView {
          Label("Not connected", systemImage: "wifi.slash")
        } description: {
          if let label = presenter.environmentLabel {
            Text("Connect to \(label) to review changes.")
          } else {
            Text("Not connected to this computer.")
          }
        }
      } else if !presenter.canReadFiles {
        ContentUnavailableView {
          Label("No review diffs", systemImage: "doc.text.magnifyingglass")
        } description: {
          Text("This connection cannot read local diffs.")
        }
      } else if review.gitStates.values.contains(.loading) {
        ProgressView().accessibilityLabel(Text("Loading diff…"))
      } else {
        ContentUnavailableView {
          Label("No review diffs", systemImage: "doc.text.magnifyingglass")
        } description: {
          Text("This thread has no ready turn diffs and the worktree diff is empty.")
        }
      }
    } else {
      switch review.selectedDiff {
      case .loading?, nil:
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityLabel(Text("Loading diff…"))
      case .failed(let failure)?:
        ContentUnavailableView {
          Label("Review unavailable", systemImage: "exclamationmark.triangle")
        } description: {
          Text(verbatim: ReviewCopy.failure(failure))
        } actions: {
          Button("Try again") { Task { await review.refresh() } }
            .buttonStyle(.glassProminent)
        }
      case .loaded(let diff)?:
        loaded(diff, selection: selection)
      }
    }
  }

  @ViewBuilder
  private func loaded(_ diff: ReviewDiff, selection: Binding<String?>?) -> some View {
    if let raw = diff.raw {
      ScrollView([.vertical, .horizontal]) {
        VStack(alignment: .leading, spacing: Spacing.md) {
          Text("Unsupported diff format. Showing raw patch.")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
          Text(verbatim: raw).font(Typography.monoSmall).textSelection(.enabled)
        }
        .padding(Spacing.lg)
      }
    } else if diff.files.isEmpty {
      ContentUnavailableView {
        Label("No changes", systemImage: "checkmark.circle")
      } description: {
        Text(verbatim: review.selected.flatMap(ReviewCopy.subtitle) ?? String(localized: "This diff is empty."))
      }
    } else if files.isEmpty {
      ContentUnavailableView {
        Label("Only test files changed", systemImage: "line.3.horizontal.decrease.circle")
      } description: {
        Text("Test files are hidden from this review.")
      } actions: {
        Button("Show test files") { hideTests = false }.buttonStyle(.glassProminent)
      }
    } else {
      fileList(diff, selection: selection)
    }
  }

  @ViewBuilder
  private func fileList(_ diff: ReviewDiff, selection: Binding<String?>?) -> some View {
    let list = List(selection: selection) {
      if diff.truncated || review.selected?.turn?.repositories.contains(where: \.baselineMissing) == true {
        Section {
          notices(diff)
        }
      }
      Section {
        ForEach(files) { file in
          row(file, selection: selection)
        }
      } header: {
        if let subtitle = review.selected.flatMap(ReviewCopy.subtitle) {
          Text(verbatim: subtitle).textCase(nil)
        }
      }
    }
    .listStyle(.insetGrouped)
    .accessibilityIdentifier("review.files")
    list
  }

  @ViewBuilder
  private func row(_ file: ReviewFile, selection: Binding<String?>?) -> some View {
    let viewed = review.isViewed(file)
    let label = ReviewFileRow(file: file, viewed: viewed)
    Group {
      if selection != nil {
        label.tag(file.id)
      } else {
        NavigationLink(value: file.id) { label }
      }
    }
    .swipeActions(edge: .leading) {
      Button {
        review.toggleViewed(file)
      } label: {
        Label(viewed ? "Not viewed" : "Viewed", systemImage: viewed ? "circle" : "checkmark.circle")
      }
      .tint(Palette.success)
    }
    .accessibilityIdentifier("review.file")
  }

  @ViewBuilder
  private func notices(_ diff: ReviewDiff) -> some View {
    if diff.truncated {
      VStack(alignment: .leading, spacing: Spacing.xs) {
        Text("Partial diff").font(Typography.footnote.weight(.semibold))
        Text(
          review.selected?.source?.files != nil
            ? "This preview exceeds the size limit. Changes shown are incomplete. Counts include all changes."
            : "Diff output hit the server size cap. Showing the available excerpt."
        )
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
      }
    }
    if let missing = review.selected?.turn?.repositories.filter(\.baselineMissing).map(\.name), !missing.isEmpty {
      Text("This turn's changes in \(missing.joined(separator: ", ")) cannot be listed.")
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
    }
  }

  // MARK: Toolbar

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Done") { dismiss() }
        .accessibilityIdentifier("review.done")
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        showsGit = true
        Task { await presenter.git.refresh() }
      } label: {
        Label("Git controls", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
      }
      .accessibilityIdentifier("review.git")
    }
    ToolbarItem(placement: .topBarTrailing) {
      sectionMenu
    }
  }

  private var sectionMenu: some View {
    let sections = review.sections
    let turns = sections.filter { $0.turn != nil }
    return Menu {
      Section {
        sectionButton(sections.first { $0.id == .git(.branchRange) }, id: .git(.branchRange))
        sectionButton(sections.first { $0.id == .git(.workingTree) }, id: .git(.workingTree))
        if let latest = turns.first {
          sectionButton(latest, id: latest.id, title: String(localized: "Latest turn"))
        } else {
          Button("Latest turn") {}.disabled(true)
        }
      }
      Section {
        Toggle(isOn: $hideTests) { Label("Hide test files", systemImage: "line.3.horizontal.decrease") }
      }
      if !turns.isEmpty {
        Menu {
          ForEach(turns) { section in
            sectionButton(section, id: section.id)
          }
        } label: {
          Label {
            Text("Turn", comment: "agent turn, diff section menu")
          } icon: {
            Image(systemName: "clock.arrow.circlepath")
          }
        }
      }
      Section {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await review.refresh() } }
      }
    } label: {
      Label("Select diff", systemImage: "line.3.horizontal.decrease.circle")
    }
    .accessibilityIdentifier("review.sections")
  }

  @ViewBuilder
  private func sectionButton(_ section: ReviewSection?, id: ReviewSectionID, title: String? = nil) -> some View {
    let selected = review.selectedId == id && section != nil
    Button {
      path = []
      splitSelection = nil
      review.select(id)
    } label: {
      Label {
        Text(verbatim: title ?? ReviewCopy.title(id))
        if let subtitle = section.flatMap(ReviewCopy.subtitle) { Text(verbatim: subtitle) }
      } icon: {
        if selected { Image(systemName: "checkmark") }
      }
    }
    .disabled(section == nil || section?.state == .loading && section?.source == nil)
    .accessibilityIdentifier("review.section.\(id.rawValue)")
  }
}

/// A pushed file: previous and next move within it instead of pushing more screens.
private struct FileDiffRoute: View {
  let presenter: ReviewPresenter
  let files: [ReviewFile]
  @State private var fileId: String?

  init(presenter: ReviewPresenter, files: [ReviewFile], initial: String) {
    self.presenter = presenter
    self.files = files
    _fileId = State(initialValue: initial)
  }

  var body: some View {
    FileDiffScreen(presenter: presenter, files: files, fileId: $fileId)
  }
}

/// A changed file in the list: its status, name and folder, counts, and the viewed mark.
struct ReviewFileRow: View {
  let file: ReviewFile
  let viewed: Bool

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: ReviewCopy.statusSymbol(file.status))
        .font(Typography.body)
        .foregroundStyle(FileStatusTint.color(file.status))
        .frame(width: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: file.name)
          .font(Typography.subheadline.weight(.medium))
          .foregroundStyle(viewed ? Palette.textSecondary : Palette.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
        if let previous = file.previousPath {
          Text("Renamed from \(previous)")
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
            .lineLimit(1)
            .truncationMode(.middle)
        } else if let directory = file.directory {
          Text(verbatim: directory)
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
            .lineLimit(1)
            .truncationMode(.head)
        }
      }
      Spacer(minLength: Spacing.sm)
      if file.additions + file.deletions > 0 {
        DiffCounts(additions: file.additions, deletions: file.deletions)
      }
      if viewed {
        Image(systemName: "checkmark.circle.fill")
          .foregroundStyle(Palette.success)
          .accessibilityHidden(true)
          .transition(.symbolEffect(.appear))
      }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
    .accessibilityValue(viewed ? Text("\(ReviewCopy.status(file.status)), viewed") : Text(verbatim: ReviewCopy.status(file.status)))
  }
}

/// Every changed file, to jump to one (RN's changed-files pane).
struct FileJumpSheet: View {
  let review: ReviewModel
  let files: [ReviewFile]
  let current: String?
  let select: (String) -> Void
  @State private var query = ""
  @Environment(\.dismiss) private var dismiss

  private var shown: [ReviewFile] {
    let trimmed = query.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? files : files.filter { $0.path.localizedCaseInsensitiveContains(trimmed) }
  }

  var body: some View {
    NavigationStack {
      List(shown) { file in
        Button {
          select(file.id)
        } label: {
          ReviewFileRow(file: file, viewed: review.isViewed(file))
        }
        .listRowBackground(file.id == current ? Palette.diffSelected : nil)
        .accessibilityAddTraits(file.id == current ? .isSelected : [])
        .accessibilityIdentifier("review.jump.file")
      }
      .listStyle(.plain)
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Find a file"))
      .navigationTitle("Changed files")
      .navigationSubtitle(String(localized: "\(files.count) files"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
