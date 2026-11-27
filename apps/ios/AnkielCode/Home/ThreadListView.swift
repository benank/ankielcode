import AnkielKit
import SwiftUI

/// Minimal home: the shell's thread titles, newest first. The real home comes in a later phase.
struct ThreadListView: View {
  @Environment(AppModel.self) private var model

  private var threads: [ThreadShell] {
    model.shell.threads.filter(\.isListed).sorted { $0.updatedAt > $1.updatedAt }
  }

  private var projectTitles: [String: String] {
    Dictionary(model.shell.projects.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
  }

  var body: some View {
    NavigationStack {
      List(threads) { thread in
        ThreadRow(thread: thread, projectTitle: projectTitles[thread.projectId])
          .listRowBackground(Palette.surface)
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(Palette.canvas)
      .scrollEdgeEffectStyle(.soft, for: .top)
      .overlay {
        if model.phase == .connected, model.shell.status != .empty, threads.isEmpty {
          ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.text.bubble.right")
        }
      }
      .navigationTitle(model.environment?.label ?? String(localized: "Threads"))
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button("Reconnect", systemImage: "arrow.clockwise") {
              Task { await model.connect() }
            }
            Button("Forget This Server", systemImage: "xmark.circle", role: .destructive) {
              model.forget()
            }
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel("Connection")
        }
      }
      .safeAreaInset(edge: .bottom) {
        GlassEffectContainer {
          ConnectionStatusPill()
        }
        .padding(.bottom, Spacing.sm)
      }
    }
  }
}

private struct ThreadRow: View {
  let thread: ThreadShell
  let projectTitle: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
      StatusDot(thread: thread)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(thread.title.isEmpty ? String(localized: "New thread") : thread.title)
          .font(Typography.body)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
        if let projectTitle {
          Text(projectTitle)
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

/// Floating glass capsule for anything but a live connection.
private struct ConnectionStatusPill: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Group {
      switch model.phase {
      case .connecting:
        StatusPill(text: "Connecting…", systemImage: "antenna.radiowaves.left.and.right")
      case .disconnected(let message):
        Button {
          Task { await model.connect() }
        } label: {
          Label("Offline · Tap to retry", systemImage: "exclamationmark.triangle.fill")
            .font(Typography.footnote.weight(.medium))
        }
        .buttonStyle(.glass)
        .tint(Palette.attention)
        .accessibilityHint(message)
      case .connected where model.shell.status != .live:
        StatusPill(text: "Syncing…", systemImage: "arrow.triangle.2.circlepath")
      default:
        EmptyView()
      }
    }
    .transition(.opacity.combined(with: .scale(scale: 0.96)))
    .animation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion), value: model.phase)
  }
}
