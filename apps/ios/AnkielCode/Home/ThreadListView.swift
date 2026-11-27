import AnkielKit
import SwiftUI

/// Minimal home: every computer's threads, newest first. Phase 4 rebuilds home.
struct ThreadListView: View {
  @Environment(AppModel.self) private var model

  private struct Row: Identifiable {
    let id: String
    let thread: ThreadShell
    let projectTitle: String?
    let environmentLabel: String?
  }

  private var rows: [Row] {
    let environments = model.registry.environments
    let showsEnvironment = environments.count > 1
    return environments.flatMap { environment in
      let titles = Dictionary(
        environment.shell.projects.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
      return environment.shell.threads.filter(\.isListed).map { thread in
        Row(
          id: "\(environment.id)/\(thread.id)", thread: thread, projectTitle: titles[thread.projectId],
          environmentLabel: showsEnvironment ? environment.label : nil)
      }
    }
    .sorted { $0.thread.updatedAt > $1.thread.updatedAt }
  }

  private var isLoading: Bool {
    model.registry.environments.contains { $0.shell.snapshot == nil && Self.isTrying($0.status) }
  }

  private var allUnavailable: Bool {
    model.registry.environments.allSatisfy { $0.shell.snapshot == nil && !Self.isTrying($0.status) }
  }

  private static func isTrying(_ status: ConnectionStatus) -> Bool {
    switch status {
    case .connecting, .connected, .reconnecting: true
    default: false
    }
  }

  var body: some View {
    let rows = rows
    NavigationStack {
      List(rows) { row in
        ThreadRow(thread: row.thread, projectTitle: row.projectTitle, environmentLabel: row.environmentLabel)
          .listRowBackground(Palette.surface)
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(Palette.canvas)
      .scrollEdgeEffectStyle(.soft, for: .top)
      .overlay {
        if rows.isEmpty {
          if isLoading {
            ProgressView("Loading threads")
          } else if allUnavailable {
            ContentUnavailableView {
              Label("Environment unavailable", systemImage: "bolt.horizontal.circle")
            } description: {
              Text("The saved environment is offline. Check the URL or start the environment, then retry.")
            } actions: {
              Button("Computers") { model.sheet = .computers }
                .buttonStyle(.glass)
            }
          } else {
            ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.text.bubble.right")
          }
        }
      }
      .navigationTitle("Threads")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Computers", systemImage: "desktopcomputer") { model.sheet = .computers }
        }
      }
      .safeAreaInset(edge: .bottom) {
        GlassEffectContainer {
          ConnectionIndicator()
        }
        .padding(.bottom, Spacing.sm)
      }
      .refreshable { model.registry.wake(.retry) }
    }
  }
}

private struct ThreadRow: View {
  let thread: ThreadShell
  let projectTitle: String?
  let environmentLabel: String?

  private var subtitle: String? {
    let parts = [projectTitle, environmentLabel].compactMap(\.self)
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
      StatusDot(thread: thread)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(thread.title.isEmpty ? String(localized: "New thread") : thread.title)
          .font(Typography.body)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
        if let subtitle {
          Text(subtitle)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(1)
        }
      }
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
  }
}

private struct StatusDot: View {
  let thread: ThreadShell

  private var color: Color {
    if thread.needsAttention { return Palette.attention }
    if thread.isWorking { return Palette.working }
    if thread.status == .failed { return Palette.danger }
    return Palette.separator
  }

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .accessibilityHidden(true)
  }
}
