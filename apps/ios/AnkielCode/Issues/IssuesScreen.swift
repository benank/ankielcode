import AnkielKit
import SwiftUI
import UIKit

/// Issues over home (RN's Issues tab): one computer's open issues across its projects' trackers,
/// searchable and filterable, each opening read-only with its comments.
struct IssuesRoot: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var issues: IssuesModel?
  @State private var path: [IssueEntry] = []

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let issues {
          IssuesList(issues: issues, open: { path.append($0) }, startThread: startThread)
        } else {
          ProgressView()
        }
      }
      .navigationDestination(for: IssueEntry.self) { entry in
        if let issues, let environmentId = issues.environmentId {
          IssueDetailScreen(entry: entry, environmentId: environmentId, source: issues.source, startThread: startThread)
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("issues.done")
        }
      }
    }
    .onAppear {
      guard issues == nil else { return }
      let fixture = IssuesDebug.source
      let environmentId = fixture == nil ? IssueComputers.choices(model.registry.environments).first?.id : IssuesDebug.environmentId
      let created = IssuesModel(source: fixture ?? model.registry, environmentId: environmentId)
      issues = created
      if let entry = IssuesDebug.openedEntry(created) { path = [entry] }
    }
  }

  /// A new thread in the issue's project, its draft holding the issue's title and link.
  private func startThread(_ entry: IssueEntry) {
    guard let environmentId = issues?.environmentId else { return }
    // Opening an entry closes this cover first, then shows the new-thread sheet.
    model.open(.newThread(prompt: IssueCalls.threadPrompt(entry), environmentId: environmentId, projectId: entry.projectId))
  }
}

private struct IssuesList: View {
  @Bindable var issues: IssuesModel
  let open: (IssueEntry) -> Void
  let startThread: (IssueEntry) -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL

  private var environment: EnvironmentModel? { issues.environmentId.flatMap { model.registry.environment($0) } }

  var body: some View {
    List {
      if !issues.unavailableTrackers.isEmpty {
        Section {
          ForEach(issues.unavailableTrackers, id: \.host) { tracker in
            Label {
              Text(verbatim: "\(tracker.host): \(tracker.detail ?? String(localized: "This tracker cannot be read."))")
            } icon: {
              Image(systemName: "exclamationmark.triangle")
            }
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
          }
        }
      }
      ForEach(issues.entries) { entry in
        Button { open(entry) } label: { IssueRow(entry: entry) }
          .buttonStyle(.plain)
          .accessibilityIdentifier("issues.row.\(entry.displayKey)")
          .contextMenu {
            Button("Open", systemImage: "arrow.forward.circle") { open(entry) }
            Button("Start a thread", systemImage: "bubble.left.and.text.bubble.right") { startThread(entry) }
            Button("Copy link", systemImage: "link") {
              UIPasteboard.general.string = entry.url
              Haptics.success()
            }
            if let url = URL(string: entry.url) {
              Button("Open on the tracker", systemImage: "safari") { openURL(url) }
            }
          }
      }
      if issues.canLoadMore {
        HStack {
          Spacer()
          ProgressView()
          Spacer()
        }
        .listRowSeparator(.hidden)
        .task { await issues.loadMore() }
      }
    }
    .listStyle(.plain)
    .overlay { overlay }
    .navigationTitle(Text("Issues", comment: "screen title, list of issues"))
    .navigationSubtitle(environment?.label ?? "")
    .searchable(text: $issues.query, prompt: Text("Search issues"))
    .onSubmit(of: .search) { issues.reload() }
    .onChange(of: issues.query) { _, query in if query.isEmpty { issues.reload() } }
    .refreshable { await issues.load(refresh: true) }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { filterMenu }
    }
    .task { if issues.phase == .idle { await issues.load() } }
    // A cold launch opens before the computer connects: read again once it does.
    .onChange(of: environment?.activeRoute != nil) { _, connected in
      if connected, issues.result == nil { issues.reload() }
    }
  }

  @ViewBuilder private var overlay: some View {
    switch issues.phase {
    case .loading:
      ProgressView()
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn't load issues", systemImage: "exclamationmark.triangle")
      } description: {
        Text(verbatim: message)
      } actions: {
        Button("Try again") { issues.reload() }
      }
    case .loaded where issues.entries.isEmpty:
      ContentUnavailableView {
        if issues.state == .closed {
          Label("No closed issues", systemImage: "smallcircle.filled.circle")
        } else {
          Label("No open issues", systemImage: "smallcircle.filled.circle")
        }
      } description: {
        if issues.result?.trackers.isEmpty == true {
          Text("None of this computer's projects is on an issue tracker it can read.")
        } else {
          Text("Issues from this computer's projects show here.")
        }
      }
    default:
      EmptyView()
    }
  }

  private var projects: [ProjectShell] {
    environment?.shell.snapshot?.projects.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending } ?? []
  }

  private var computers: [EnvironmentModel] { IssueComputers.choices(model.registry.environments) }

  private var filterMenu: some View {
    Menu {
      if computers.count > 1 {
        Picker(selection: $issues.environmentId) {
          ForEach(computers, id: \.id) { computer in
            Text(verbatim: computer.label).tag(String?.some(computer.id))
          }
        } label: {
          Text("Computer", comment: "filter menu heading")
        }
        .pickerStyle(.inline)
      }
      Picker(selection: $issues.state) {
        Text("Open").tag(IssueStateFilter.open)
        Text("Closed").tag(IssueStateFilter.closed)
        Text("All").tag(IssueStateFilter.all)
      } label: {
        Text("State")
      }
      if !projects.isEmpty {
        Picker(selection: $issues.projectId) {
          Text("All projects").tag(String?.none)
          ForEach(projects) { project in
            Text(verbatim: project.title).tag(String?.some(project.id))
          }
        } label: {
          Text("Project")
        }
        .pickerStyle(.menu)
      }
    } label: {
      Label("Filter", systemImage: "line.3.horizontal.decrease")
    }
    .accessibilityIdentifier("issues.filter")
  }
}

/// A list row (RN `IssueListRow`): state, key and project, title, labels, comments and age.
struct IssueRow: View {
  let entry: IssueEntry

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
      IssueStateIcon(state: entry.state)
      VStack(alignment: .leading, spacing: Spacing.xs) {
        Text(verbatim: entry.title)
          .font(Typography.body)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(3)
        HStack(spacing: Spacing.xs) {
          Text(verbatim: "\(entry.displayKey) · \(entry.projectTitle)")
          if let age = IssueCopy.relative(entry.updatedAt) { Text(verbatim: "· \(age)") }
          if entry.commentCount > 0 {
            HStack(spacing: Spacing.xxs) {
              Text(verbatim: "·")
              Image(systemName: "bubble.left")
              Text(verbatim: "\(entry.commentCount)")
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("^[\(entry.commentCount) comment](inflect: true)"))
          }
        }
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .lineLimit(1)
        if !entry.labels.isEmpty {
          IssueLabels(labels: entry.labels)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, Spacing.xs)
    .contentShape(.rect)
  }
}

struct IssueStateIcon: View {
  let state: IssueState

  var body: some View {
    Image(systemName: state.isOpen ? "smallcircle.filled.circle" : "checkmark.circle")
      .foregroundStyle(state.isOpen ? Palette.success : Palette.textTertiary)
      .accessibilityLabel(Text(verbatim: state.name))
  }
}

/// Labels as small capsules, in their tracker colour when it has one.
struct IssueLabels: View {
  let labels: [IssueLabel]

  var body: some View {
    HStack(spacing: Spacing.xs) {
      ForEach(labels.prefix(4), id: \.name) { label in
        Text(verbatim: label.name)
          .font(Typography.caption)
          .lineLimit(1)
          .padding(.horizontal, Spacing.sm)
          .padding(.vertical, Spacing.xxs)
          .foregroundStyle(Palette.textSecondary)
          .background(color(label).opacity(0.18), in: .capsule)
      }
      if labels.count > 4 {
        Text(verbatim: "+\(labels.count - 4)").font(Typography.caption).foregroundStyle(Palette.textTertiary)
      }
    }
  }

  private func color(_ label: IssueLabel) -> Color {
    guard let hex = label.color, let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else {
      return Palette.textTertiary
    }
    return Color(uiColor: UIColor(rgb: value))
  }
}
