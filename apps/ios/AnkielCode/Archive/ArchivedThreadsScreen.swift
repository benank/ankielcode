import AnkielKit
import SwiftUI

/// Settings → Archive (RN `ArchivedThreadsScreen`): archived threads per computer and project,
/// searchable, filtered by computer and sorted by archive date. Swipe or long-press to unarchive
/// (with Undo) or delete for good; tap to read the thread.
struct ArchivedThreadsScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var archive: ArchiveModel
  @State private var clock = MinuteClock()
  @State private var deleting: ArchivedThreadList.Row?
  @State private var actions = 0

  init(registry: EnvironmentRegistry) {
    _archive = State(initialValue: ArchiveModel(registry: registry))
  }

  var body: some View {
    @Bindable var bindable = archive
    list(archive)
      .navigationTitle("Archived threads")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $bindable.query, prompt: Text("Search archived threads"))
      .toolbar { ToolbarItem(placement: .topBarTrailing) { options(archive) } }
      .refreshable { await archive.refresh() }
      .overlay { emptyState(archive) }
      .safeAreaInset(edge: .bottom, spacing: 0) { undoBar(archive) }
      .environment(clock)
      .task { await clock.run() }
      .task { await archive.refresh() }
      .onChange(of: archive.environments.map(\.status.isConnected)) { _, _ in
        Task { await archive.connectionsChanged() }
      }
      .onChange(of: archive.query) { _, _ in archive.dismissUndo() }
      .sensoryFeedback(.impact(weight: .light), trigger: actions)
      .alert("Delete thread?", isPresented: deletePresented, presenting: deleting) { row in
        Button("Cancel", role: .cancel) {}
        Button("Delete", role: .destructive) {
          actions += 1
          archive.delete(row)
        }
        .accessibilityIdentifier("archive.confirmDelete")
      } message: { row in
        Text("“\(row.title)” will be permanently deleted, including its terminal history.")
      }
      .alert(item: $bindable.failure) { failure in
        Alert(title: Text(failure.title), message: Text(failure.message))
      }
  }

  private func list(_ archive: ArchiveModel) -> some View {
    let page = archive.page
    return List {
      ForEach(archive.failures, id: \.label) { failure in
        Label {
          VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("Could not load \(failure.label)")
              .foregroundStyle(Palette.textPrimary)
            Text(failure.message)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
        } icon: {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(Palette.attention)
        }
        .accessibilityElement(children: .combine)
      }
      ForEach(page.groups) { group in
        Section {
          ForEach(group.rows) { row in
            rowView(row, archive: archive)
          }
        } header: {
          Text(archive.environments.count > 1 ? "\(group.projectTitle) · \(group.environmentLabel)" : group.projectTitle)
        }
      }
      if page.more > 0 {
        Button {
          archive.showMore()
        } label: {
          Text("Show \(min(page.more, ArchiveModel.pageSize)) more")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .accessibilityIdentifier("archive.showMore")
      }
    }
    .animation(Motion.resolve(Motion.snappy, reduceMotion: reduceMotion), value: page.groups.flatMap(\.rows).map(\.id))
  }

  private func rowView(_ row: ArchivedThreadList.Row, archive: ArchiveModel) -> some View {
    let operable = archive.canOperate(row.ref)
    return NavigationLink(value: SettingsRoute.archivedThread(row.ref)) {
      ArchivedThreadRow(row: row)
    }
    .accessibilityIdentifier("archive.thread.\(row.ref.threadId)")
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if operable {
        Button {
          actions += 1
          archive.unarchive(row)
        } label: {
          Label("Unarchive", systemImage: "tray.and.arrow.up")
        }
        .tint(Palette.working)
        .accessibilityLabel(Text("Unarchive \(row.title)"))
        Button(role: .destructive) {
          deleting = row
        } label: {
          Label("Delete", systemImage: "trash")
        }
      }
    }
    .contextMenu {
      if operable {
        Button("Unarchive", systemImage: "tray.and.arrow.up") {
          actions += 1
          archive.unarchive(row)
        }
        Button("Delete", systemImage: "trash", role: .destructive) { deleting = row }
      }
    }
  }

  private func options(_ archive: ArchiveModel) -> some View {
    @Bindable var archive = archive
    return Menu {
      if archive.environments.count > 1 {
        Picker(selection: $archive.environmentFilter) {
          Text("All computers").tag(String?.none)
          ForEach(archive.environments, id: \.id) { environment in
            Text(environment.label).tag(Optional(environment.id))
          }
        } label: {
          Text("Computer", comment: "filter menu heading")
        }
        .pickerStyle(.inline)
      }
      Picker(selection: $archive.order) {
        Text("Newest first").tag(ArchivedThreadList.SortOrder.newest)
        Text("Oldest first").tag(ArchivedThreadList.SortOrder.oldest)
      } label: {
        Text("Sort by archived date")
      }
      .pickerStyle(.inline)
      Button("Refresh archived threads", systemImage: "arrow.clockwise") {
        Task { await archive.refresh() }
      }
    } label: {
      Label("Archived thread options", systemImage: archive.environmentFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
    }
    .accessibilityIdentifier("archive.options")
  }

  @ViewBuilder
  private func emptyState(_ archive: ArchiveModel) -> some View {
    if archive.groups.isEmpty, archive.failures.isEmpty || archive.isFiltered {
      if archive.isLoading {
        ProgressView()
      } else if archive.isFiltered {
        ContentUnavailableView {
          Label("No matching threads", systemImage: "magnifyingglass")
        } description: {
          Text("Try another search or computer.")
        }
      } else {
        ContentUnavailableView {
          Label("No archived threads", systemImage: "archivebox")
        } description: {
          Text("Threads you archive will appear here.")
        }
      }
    }
  }

  private func undoBar(_ archive: ArchiveModel) -> some View {
    VStack {
      if archive.undo != nil {
        HStack(spacing: Spacing.md) {
          Text("Unarchived thread")
            .font(Typography.subheadline.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
          Button("Undo") {
            actions += 1
            archive.performUndo()
          }
          .font(Typography.subheadline.weight(.semibold))
          .accessibilityIdentifier("archive.undo")
        }
        .padding(.horizontal, Spacing.lg)
        .frame(minHeight: 44)
        .chromeGlass(interactive: true)
        .accessibilityElement(children: .contain)
        .motionTransition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .padding(.bottom, Spacing.sm)
    .animation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion), value: archive.undo)
  }

  private var deletePresented: Binding<Bool> {
    Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
  }
}

/// One archived thread: title, when it was archived, and its branch.
private struct ArchivedThreadRow: View {
  let row: ArchivedThreadList.Row

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xxs) {
      HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
        Text(row.title.isEmpty ? String(localized: "Untitled thread") : row.title)
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
        Spacer(minLength: Spacing.sm)
        RelativeTimeText(date: row.archivedAt)
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .monospacedDigit()
      }
      if let branch = row.branch, !branch.isEmpty {
        Label(branch, systemImage: "arrow.triangle.branch")
          .font(Typography.monoCaption)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
          .labelStyle(.titleAndIcon)
      }
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
  }
}
