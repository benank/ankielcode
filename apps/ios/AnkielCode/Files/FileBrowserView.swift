import AnkielKit
import SwiftUI

/// The workspace's files: a lazily listed tree (folders open in place), and search by path on the
/// server. Tapping a file opens it in the viewer on the same stack.
struct FileBrowserView: View {
  let presenter: FilePresenter
  @State private var tree = FileTree()
  @State private var query = ""
  @State private var results: SearchState = .idle
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  enum SearchState: Equatable {
    case idle
    case searching
    case found([WorkspaceEntry], truncated: Bool)
    case failed(String)
  }

  private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

  var body: some View {
    List {
      if searching {
        searchRows
      } else {
        treeRows
      }
    }
    .listStyle(.plain)
    .environment(\.defaultMinListRowHeight, 44)
    .scrollContentBackground(.hidden)
    .background(Palette.canvas)
    .navigationTitle(Text("Files", comment: "screen title, workspace files"))
    .navigationSubtitle(presenter.context?.title ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search files"))
    .autocorrectionDisabled()
    .textInputAutocapitalization(.never)
    .refreshable { await refresh() }
    .task {
      #if DEBUG
        if let debugQuery = FilesDebug.searchQuery, query.isEmpty { query = debugQuery }
      #endif
    }
    .task(id: presenter.isConnected) {
      // Opened while the computer reconnects: list once it is back (and retry failed folders).
      guard presenter.isConnected else { return }
      if case .failed? = tree.root { tree.invalidate() }
      await listPending()
    }
    .task(id: [query, presenter.isConnected ? "1" : "0"]) { await search() }
    .navigationDestination(for: FileTarget.self) { target in
      FilePreviewView(target: target, presenter: presenter)
    }
    .accessibilityIdentifier("files.browser")
  }

  // MARK: Tree

  @ViewBuilder
  private var treeRows: some View {
    switch tree.root {
    case nil, .loading?:
      loadingRow
    case .failed(let error)?:
      FilesUnavailable(message: Self.message(error)) { Task { await refresh() } }
    case .loaded(let entries, _)? where entries.isEmpty:
      ContentUnavailableView("No files found", systemImage: "folder", description: Text("The workspace is empty."))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    case .loaded?:
      ForEach(tree.rows) { row in
        if row.entry.isDirectory {
          Button { toggle(row.entry.path) } label: {
            FileRowLabel(entry: row.entry, depth: row.depth, expanded: row.expanded, loading: row.listing == .loading)
          }
          .buttonStyle(.plain)
          .accessibilityValue(row.expanded ? Text("Expanded") : Text("Collapsed"))
          .accessibilityIdentifier("files.row.\(row.entry.path)")
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(Self.rowInsets)
          if case .failed(let error)? = row.listing {
            Text(Self.message(error))
              .font(Typography.caption)
              .foregroundStyle(Palette.danger)
              .padding(.leading, CGFloat(row.depth + 1) * FileRowLabel.indent + Spacing.xl)
              .listRowBackground(Color.clear)
          }
        } else {
          NavigationLink(value: FileTarget.workspace(path: row.entry.path, line: nil)) {
            FileRowLabel(entry: row.entry, depth: row.depth, expanded: false, loading: false)
          }
          .accessibilityIdentifier("files.row.\(row.entry.path)")
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(Self.rowInsets)
        }
      }
      if case .loaded(_, true)? = tree.root {
        Text("Some files are not listed.")
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .listRowBackground(Color.clear)
      }
    }
  }

  private var loadingRow: some View {
    ProgressView()
      .frame(maxWidth: .infinity, minHeight: 120)
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
      .accessibilityLabel(Text("Loading files"))
  }

  private func toggle(_ path: String) {
    let needsListing = withMotion(Motion.snappy, reduceMotion: reduceMotion) { tree.toggle(path) }
    Haptics.selection()
    if needsListing { Task { await list(path) } }
  }

  private func listPending() async {
    // Folders open at once list side by side; the root comes first.
    let pending = tree.pending
    await withDiscardingTaskGroup { group in
      for path in pending { group.addTask { await list(path) } }
    }
  }

  private func list(_ path: String) async {
    guard let context = presenter.context, let registry = presenter.registry else {
      tree.finish(path, .failure(.notConnected))
      return
    }
    tree.begin(path)
    do {
      let entries = try await registry.listEntries(path, in: context)
      withMotion(Motion.snappy, reduceMotion: reduceMotion) { tree.finish(path, .success(entries)) }
    } catch {
      tree.finish(path, .failure(error))
    }
  }

  private func refresh() async {
    tree.invalidate()
    await listPending()
  }

  // MARK: Search

  @ViewBuilder
  private var searchRows: some View {
    switch results {
    case .idle, .searching:
      loadingRow
    case .failed(let message):
      FilesUnavailable(message: message) { Task { await search() } }
    case .found(let entries, _) where entries.isEmpty:
      ContentUnavailableView("No files found", systemImage: "magnifyingglass", description: Text("Try a different search."))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    case .found(let entries, let truncated):
      ForEach(entries) { entry in
        if entry.isDirectory {
          Button {
            query = ""
            revealFolder(entry.path)
          } label: {
            SearchRowLabel(entry: entry)
          }
          .buttonStyle(.plain)
          .listRowBackground(Color.clear)
        } else {
          NavigationLink(value: FileTarget.workspace(path: entry.path, line: nil)) { SearchRowLabel(entry: entry) }
            .accessibilityIdentifier("files.result.\(entry.path)")
            .listRowBackground(Color.clear)
        }
      }
      if truncated {
        Text("Showing the first \(entries.count) matches.")
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .listRowBackground(Color.clear)
      }
    }
  }

  /// Opens every folder down to `path` in the tree (a folder picked from search).
  private func revealFolder(_ path: String) {
    var prefix = ""
    for segment in path.split(separator: "/") {
      prefix = prefix.isEmpty ? String(segment) : prefix + "/" + segment
      if !tree.expanded.contains(prefix) { tree.toggle(prefix) }
    }
    Task { await listPending() }
  }

  private func search() async {
    guard searching else {
      results = .idle
      return
    }
    // Debounce typing (RN waits 200 ms); a new keystroke cancels this task.
    try? await Task.sleep(for: .milliseconds(200))
    guard !Task.isCancelled, let context = presenter.context, let registry = presenter.registry else { return }
    if case .found = results {} else { results = .searching }
    do {
      let found = try await registry.searchEntries(query, in: context)
      guard !Task.isCancelled else { return }
      results = .found(found.entries, truncated: found.truncated)
    } catch {
      guard !Task.isCancelled else { return }
      results = .failed(Self.message(error))
    }
  }

  static let rowInsets = EdgeInsets(top: 0, leading: Spacing.md, bottom: 0, trailing: Spacing.lg)

  static func message(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "This environment is not connected.")
    case .rejected(let message, let tag):
      tag == "EnvironmentAuthorizationError"
        ? String(localized: "This device is not allowed to read files on this computer.")
        : message ?? String(localized: "The computer could not list these files.")
    case .failed(let message): message
    }
  }
}

private struct FileRowLabel: View {
  let entry: WorkspaceEntry
  let depth: Int
  let expanded: Bool
  let loading: Bool
  static let indent: CGFloat = 16

  var body: some View {
    HStack(spacing: Spacing.sm) {
      if entry.isDirectory {
        Image(systemName: "chevron.right")
          .font(Typography.caption.weight(.semibold))
          .foregroundStyle(Palette.textTertiary)
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .frame(width: 14)
      } else {
        Color.clear.frame(width: 14)
      }
      Image(systemName: FileIcon.symbol(for: entry.name, isDirectory: entry.isDirectory))
        .symbolVariant(entry.isDirectory && expanded ? .fill : .none)
        .foregroundStyle(entry.isDirectory ? Palette.textSecondary : Palette.textTertiary)
        .frame(width: 22)
      Text(entry.name)
        .font(Typography.body)
        .foregroundStyle(entry.ignored == true ? Palette.textTertiary : Palette.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 0)
      if loading {
        ProgressView().controlSize(.small)
      }
    }
    .padding(.leading, CGFloat(depth) * Self.indent)
    .frame(minHeight: 44)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text(entry.name))
    .accessibilityHint(entry.isDirectory ? Text("Folder") : Text(""))
  }
}

private struct SearchRowLabel: View {
  let entry: WorkspaceEntry

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: FileIcon.symbol(for: entry.name, isDirectory: entry.isDirectory))
        .foregroundStyle(Palette.textTertiary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(entry.name).font(Typography.body).foregroundStyle(Palette.textPrimary).lineLimit(1)
        let parent = WorkspacePath.parent(entry.path)
        if !parent.isEmpty {
          Text(parent).font(Typography.caption).foregroundStyle(Palette.textTertiary).lineLimit(1).truncationMode(.head)
        }
      }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
  }
}

private struct FilesUnavailable: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Files unavailable", systemImage: "exclamationmark.triangle")
    } description: {
      Text(message)
    } actions: {
      Button("Try again", action: retry).buttonStyle(.glass)
    }
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }
}
