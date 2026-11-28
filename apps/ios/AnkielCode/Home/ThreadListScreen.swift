import AnkielKit
import SwiftUI
import UIKit

/// The thread list with its chrome: large title and connection status, search, the filter menu,
/// Computers and Settings, the floating New thread button, swipe actions, context menus, and the
/// undo notice.
struct ThreadListScreen: View {
  /// The zoom transition's namespace on compact width; nil in the split view.
  let zoom: Namespace.ID?

  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var clock = MinuteClock()
  @State private var renaming: RenameRequest?
  @State private var deleting: ThreadRow?
  @State private var snoozing: ThreadRow?
  @State private var actionCount = 0
  @FocusState private var searchFocused: Bool

  private struct RenameRequest: Identifiable {
    let ref: ThreadRef
    var title: String
    var id: String { ref.key }
  }

  var body: some View {
    @Bindable var home = model.home
    dialogs(
      list
        .searchable(text: $home.searchQuery, prompt: Text("Search", comment: "search field placeholder"))
        .searchFocused($searchFocused)
        .onChange(of: model.navigator.searchRequested, initial: true) { _, requested in
          guard requested else { return }
          model.navigator.searchRequested = false
          // After the key press that asked for it finishes, or the focus change is dropped.
          Task { searchFocused = true }
        }
        .refreshable {
          Haptics.tap(.soft)
          await home.refresh()
        }
        .overlay { emptyState }
        .fullScreenCover(item: Bindable(model.navigator).cover) { cover in
          switch cover {
          case .issues: IssuesRoot()
          case .workflows: WorkflowsRoot()
          }
        }
        .navigationTitle("Threads")
        .navigationSubtitle(statusText ?? "")
        .toolbar { toolbar }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomChrome }
        .environment(clock)
        .task { await clock.run() }
        .sensoryFeedback(.impact(weight: .light), trigger: actionCount)
    )
  }

  private var list: some View {
    List {
      listRows
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Palette.canvas)
    .environment(\.defaultMinListRowHeight, 0)
    .animation(Motion.resolve(Motion.snappy, reduceMotion: reduceMotion), value: model.home.layout.items.map(\.id))
    .scrollEdgeEffectStyle(.soft, for: .top)
  }

  @ViewBuilder
  private var listRows: some View {
    let home = model.home
    ForEach(home.layout.items) { item in
      switch item {
      case .thread(let row):
        threadRow(row)
      case .folder(let folder):
        folderRow(folder)
      case .shelf(let shelf, let count, let expanded):
        shelfRow(shelf, count: count, expanded: expanded)
      }
    }
    if home.layout.hiddenSettledCount > 0 {
      ShowMoreRow(hidden: home.layout.hiddenSettledCount, state: home.olderSettledState) { home.showMoreSettled() }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
  }

  private func folderRow(_ folder: ProjectFolder) -> some View {
    Button {
      withMotion(Motion.snappy, reduceMotion: reduceMotion) { model.home.toggleFolder(folder.folderKey) }
    } label: {
      FolderHeaderRow(folder: folder)
    }
    .buttonStyle(.plain)
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 0, leading: Spacing.lg, bottom: 0, trailing: Spacing.lg))
    .accessibilityIdentifier("folder.\(folder.folderKey)")
  }

  private func shelfRow(_ shelf: ThreadShelf, count: Int, expanded: Bool) -> some View {
    Button {
      withMotion(Motion.snappy, reduceMotion: reduceMotion) { model.home.toggle(shelf) }
    } label: {
      ShelfHeaderRow(shelf: shelf, count: count, expanded: expanded)
    }
    .buttonStyle(.plain)
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 0, leading: Spacing.lg, bottom: 0, trailing: Spacing.lg))
    .accessibilityIdentifier("shelf.\(shelf.rawValue)")
  }

  private func dialogs(_ content: some View) -> some View {
    @Bindable var home = model.home
    return content
      .alert("Rename thread", isPresented: renamePresented, presenting: renaming) { request in
        TextField("Title", text: renameText)
          .accessibilityIdentifier("rename.field")
        Button("Cancel", role: .cancel) {}
        Button("Save") { home.rename(request.ref, to: renaming?.title ?? request.title) }
          .accessibilityIdentifier("rename.save")
      }
      .alert("Delete thread?", isPresented: deletePresented, presenting: deleting) { row in
        Button("Cancel", role: .cancel) {}
        Button("Delete", role: .destructive) { home.perform(.delete, on: row.ref) }
      } message: { row in
        Text("“\(row.title)” will be permanently deleted, including its terminal history.")
      }
      .confirmationDialog("Snooze until", isPresented: snoozePresented, titleVisibility: .visible, presenting: snoozing) {
        row in
        ForEach(SnoozePreset.resolve(model.snoozePresets(row.ref.environmentId), now: .now)) { preset in
          Button("\(ThreadCopy.snoozeLabel(preset)) · \(ThreadCopy.snoozeWhen(preset, now: .now))") {
            commit { home.snooze(row, until: preset.wake) }
          }
        }
      }
      .alert(item: $home.failure) { failure in
        Alert(title: Text(failure.title), message: Text(failure.message))
      }
  }

  // MARK: Rows

  @ViewBuilder
  private func threadRow(_ row: ThreadRow) -> some View {
    let home = model.home
    let operable = home.canOperate(row.ref)
    let selected = home.selectedKey == row.id
    Button {
      model.navigator.open(row.ref)
    } label: {
      ThreadRowView(row: row, selected: selected)
        .equatable()
    }
    .buttonStyle(.plain)
    .modifier(ZoomSource(id: row.id, namespace: zoom))
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(top: 0, leading: Spacing.lg, bottom: 0, trailing: Spacing.lg))
    .listRowBackground(
      RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        .fill(selected ? Palette.fill : Color.clear)
        .padding(.horizontal, Spacing.sm)
    )
    .accessibilityIdentifier("thread.\(row.ref.threadId)")
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if operable { trailingSwipes(row) }
    }
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if operable, let toggle = row.readToggle {
        Button {
          commit { home.toggleRead(row) }
        } label: {
          if case .markRead = toggle {
            Label("Read", systemImage: "envelope.open")
          } else {
            Label("Unread", systemImage: "envelope.badge")
          }
        }
        .tint(Palette.working)
      }
    }
    .contextMenu {
      ThreadActionsMenu(
        row: row, operable: operable, rename: { renaming = RenameRequest(ref: row.ref, title: row.title) },
        delete: { deleting = row }, commit: commit)
    }
  }

  @ViewBuilder
  private func trailingSwipes(_ row: ThreadRow) -> some View {
    let home = model.home
    switch row.swipe.primary {
    case .settle:
      Button { commit { home.settle(row) } } label: { Label("Settle", systemImage: "checkmark") }
        .tint(Palette.success)
    case .unsettle:
      Button { commit { home.perform(.unsettle(), on: row.ref) } } label: {
        Label("Un-settle", systemImage: "arrow.uturn.backward")
      }
      .tint(Palette.working)
    case .unsnooze:
      Button { commit { home.perform(.unsnooze, on: row.ref) } } label: { Label("Wake", systemImage: "clock") }
        .tint(Palette.working)
    case .archive:
      Button { commit { home.archive(row) } } label: { Label("Archive", systemImage: "archivebox") }
        .tint(Palette.textSecondary)
    }
    if row.swipe.snooze {
      Button { snoozing = row } label: { Label("Snooze", systemImage: "moon.zzz") }
        .tint(Palette.attention)
    }
  }

  /// A committed list action: one light haptic, then the action.
  private func commit(_ action: () -> Void) {
    actionCount += 1
    action()
  }

  // MARK: Chrome

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      FilterMenu()
    }
    ToolbarItemGroup(placement: .topBarTrailing) {
      UsageToolbarButton()
      // The screens beside the thread list share one menu, so the bar stays the same on iPhone and
      // iPad however many there are.
      Menu {
        if showsIssues {
          Button("Issues", systemImage: "smallcircle.filled.circle") { model.navigator.cover = .issues }
            .accessibilityIdentifier("home.issues")
        }
        Button("Workflows", systemImage: "point.3.connected.trianglepath.dotted") { model.navigator.cover = .workflows }
          .accessibilityIdentifier("home.workflows")
        Section {
          Button("Settings", systemImage: "gearshape") { model.openSettings() }
            .accessibilityIdentifier("home.settings")
        }
      } label: {
        // Not "More": thread and row menus have a More of their own.
        Label("Menu", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("home.more")
    }
    if zoom == nil {
      // The sidebar keeps search at its top, so compose joins the top bar (iPad Mail).
      ToolbarItem(placement: .topBarTrailing) { newThreadButton }
    } else {
      // Search and compose share the bottom bar, as in iOS 26 Mail.
      DefaultToolbarItem(kind: .search, placement: .bottomBar)
      ToolbarSpacer(.fixed, placement: .bottomBar)
      ToolbarItem(placement: .bottomBar) { newThreadButton }
    }
  }

  /// Issues need a computer that can read them (RN hides the tab otherwise).
  private var showsIssues: Bool {
    !IssueComputers.choices(model.registry).isEmpty || IssuesDebug.source != nil
  }

  private var newThreadButton: some View {
    Button("New thread", systemImage: "square.and.pencil") { model.navigator.sheet = .newThread }
      .accessibilityIdentifier("home.newThread")
  }

  private var bottomChrome: some View {
    let home = model.home
    return VStack(spacing: Spacing.sm) {
      if let notice = home.undo {
        UndoNoticeView(notice: notice) {
          actionCount += 1
          home.performUndo()
        }
        .motionTransition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.bottom, Spacing.sm)
    .animation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion), value: home.undo)
  }

  /// `WorkspaceConnectionTitle`: the workspace status under the title while something is off.
  private var statusText: String? {
    let environments = model.registry.environments.filter(\.isEnabled)
    guard !environments.isEmpty else { return nil }
    if environments.allSatisfy({ $0.status == .offline }) { return String(localized: "You are offline") }
    let ready = environments.filter { $0.status.isConnected }
    if !ready.isEmpty {
      return ready.contains { $0.shell.status != .live }
        ? (ready.contains { $0.shell.snapshot != nil } ? String(localized: "Syncing threads…") : String(localized: "Loading threads…"))
        : nil
    }
    let connecting = environments.filter {
      switch $0.status {
      case .connecting, .reconnecting: true
      default: false
      }
    }
    if connecting.count == 1 { return String(localized: "Reconnecting to \(connecting[0].label)") }
    if connecting.count > 1 { return String(localized: "Reconnecting \(connecting.count) computers") }
    if let failed = environments.first {
      return ConnectionPresentation.indicatorText(failed.status, host: failed.label)
    }
    return String(localized: "Not connected")
  }

  // MARK: Empty states

  @ViewBuilder
  private var emptyState: some View {
    let home = model.home
    if home.hasLaidOut, home.layout.items.isEmpty {
      if !home.layout.hasAnyThreads {
        HomeEmptyState(environments: model.registry.environments) {
          model.navigator.sheet = .newThread
        } computers: {
          model.openSettings(.computers)
        }
      } else if !home.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
        if home.search.pending {
          ContentUnavailableView {
            Label("Searching thread messages…", systemImage: "magnifyingglass")
          } description: {
            Text("Looking for “\(home.searchQuery)” in messages.")
          }
        } else if home.search.failed {
          ContentUnavailableView {
            Label("Search failed", systemImage: "exclamationmark.magnifyingglass")
          } description: {
            Text("Could not search messages for “\(home.searchQuery)”. Change the search to try again.")
          }
        } else {
          ContentUnavailableView.search(text: home.searchQuery)
        }
      } else if let scope = home.projectFilter {
        filteredEmpty(name: scope.title ?? String(localized: "No project"), detail: String(localized: "Choose another project or create a new task."))
      } else if let id = home.environmentFilterResolved, let label = home.environmentChoices.first(where: { $0.id == id })?.label {
        filteredEmpty(name: label, detail: String(localized: "Choose another computer or create a new task."))
      } else {
        ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.text.bubble.right",
          description: Text("Create a task to start a new coding session."))
      }
    }
  }

  private func filteredEmpty(name: String, detail: String) -> some View {
    ContentUnavailableView {
      Label("No threads in \(name)", systemImage: "line.3.horizontal.decrease.circle")
    } description: {
      Text(detail)
    } actions: {
      Button("Show all threads") {
        model.home.setEnvironmentFilter(nil)
        model.home.setProjectFilter(nil)
      }
      .buttonStyle(.glass)
    }
  }

  // MARK: Bindings

  private var renamePresented: Binding<Bool> {
    Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
  }

  private var renameText: Binding<String> {
    Binding(get: { renaming?.title ?? "" }, set: { renaming?.title = $0 })
  }

  private var deletePresented: Binding<Bool> {
    Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
  }

  private var snoozePresented: Binding<Bool> {
    Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } })
  }
}

/// The row is the zoom transition's source on compact width.
private struct ZoomSource: ViewModifier {
  let id: String
  let namespace: Namespace.ID?

  func body(content: Content) -> some View {
    if let namespace {
      content.matchedTransitionSource(id: id, in: namespace)
    } else {
      content
    }
  }
}

/// "Show more" under a capped Settled shelf, or its loading and failed states.
private struct ShowMoreRow: View {
  let hidden: Int
  let state: OlderSettledPages.Status
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Group {
        switch state {
        case .loading: Text("Loading", comment: "older threads are loading")
        case .failed: Text("Could not load older threads. Tap to retry.")
        case .ready: Text("Show more (\(hidden) settled hidden)")
        }
      }
      .font(Typography.footnote.weight(.medium))
      .foregroundStyle(Palette.textSecondary)
      .frame(maxWidth: .infinity, minHeight: 44)
    }
    .buttonStyle(.plain)
    .disabled(state == .loading)
    .accessibilityIdentifier("settled.showMore")
  }
}

/// "Settled thread · Undo" for five seconds after a settle, snooze, unpin or archive.
private struct UndoNoticeView: View {
  let notice: HomeModel.UndoNotice
  let undo: () -> Void

  var body: some View {
    HStack(spacing: Spacing.md) {
      Text(text)
        .font(Typography.subheadline.weight(.medium))
        .foregroundStyle(Palette.textPrimary)
      Button("Undo", action: undo)
        .font(Typography.subheadline.weight(.semibold))
        .accessibilityIdentifier("undo.button")
    }
    .padding(.horizontal, Spacing.lg)
    .frame(minHeight: 44)
    .chromeGlass(interactive: true)
    .accessibilityElement(children: .contain)
  }

  private var text: String {
    switch notice.kind {
    case .settled: String(localized: "Settled thread")
    case .snoozed: String(localized: "Snoozed thread")
    case .unpinned: String(localized: "Unpinned thread")
    case .archived: String(localized: "Archived thread")
    }
  }
}
