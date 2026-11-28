import AnkielKit
import SwiftUI

/// A run to show, on the computer it belongs to.
struct WorkflowRunRoute: Hashable {
  let environmentId: String
  let runId: String
}

/// Workflows over home (RN's Workflows tab): what waits on you first, on every computer.
struct WorkflowsRoot: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var workflows: WorkflowsModel?
  @State private var path: [WorkflowRunRoute] = []

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let workflows {
          WorkflowsList(workflows: workflows) { path.append($0) }
        } else {
          ProgressView()
        }
      }
      .navigationTitle("Workflows")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: WorkflowRunRoute.self) { route in
        if let workflows {
          WorkflowRunScreen(route: route, workflows: workflows, openRun: { path.append($0) }, openThread: openThread)
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("workflows.done")
        }
      }
    }
    .onAppear {
      guard workflows == nil else { return }
      let created = WorkflowsDebug.model() ?? WorkflowsModel(registry: model.registry, source: model.registry)
      workflows = created
      created.start()
      if let route = WorkflowsDebug.openedRun { path = [route] }
    }
    .onDisappear { workflows?.stop() }
  }

  /// An agent's thread: the cover closes and the thread opens from home.
  private func openThread(_ ref: ThreadRef) {
    let model = model
    dismiss()
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(450))
      model.open(.thread(ref))
    }
  }
}

private struct WorkflowsList: View {
  let workflows: WorkflowsModel
  let open: (WorkflowRunRoute) -> Void
  @State private var tab: WorkflowListTab?
  @State private var showSkipped: Set<String> = []

  private struct Section: Identifiable {
    let id: String
    let label: String
    let groups: WorkflowRunGroups
    let skipped: Int
  }

  private var sections: [Section] {
    workflows.computers.compactMap { computer in
      guard let snapshot = computer.snapshot, !snapshot.runs.isEmpty else { return nil }
      let visible = Workflows.listed(snapshot.runs, showSkipped: showSkipped.contains(computer.id))
      return Section(
        id: computer.id, label: computer.label,
        groups: Workflows.group(workflows: snapshot.workflows, runs: visible.runs, questions: snapshot.questions),
        skipped: visible.skipped)
    }
  }

  var body: some View {
    let sections = sections
    // Opens on the most pressing list any computer has.
    let opening = WorkflowListTab.allCases.first { candidate in sections.contains { Workflows.defaultTab($0.groups) == candidate } } ?? .all
    let shown = tab ?? opening
    ThemedList {
      ForEach(workflows.computers.filter { $0.snapshot == nil && $0.error != nil }) { computer in
        Label {
          Text(workflows.computers.count > 1 ? "\(computer.label): \(computer.error ?? "")" : computer.error ?? "")
        } icon: {
          Image(systemName: "exclamationmark.triangle").foregroundStyle(Palette.attention)
        }
        .font(Typography.subheadline)
      }
      if !sections.isEmpty {
        Picker("Runs", selection: Binding(get: { shown }, set: { tab = $0 })) {
          ForEach(WorkflowListTab.allCases, id: \.self) { tab in Text(WorkflowCopy.tab(tab)).tag(tab) }
        }
        .pickerStyle(.segmented)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: Spacing.sm, leading: Spacing.lg, bottom: Spacing.sm, trailing: Spacing.lg))
        .accessibilityIdentifier("workflows.tabs")
        ForEach(sections) { section in
          let nodes = Workflows.lists(section.groups)[shown] ?? []
          SwiftUI.Section {
            if nodes.isEmpty {
              Text(WorkflowCopy.nothing(shown))
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Spacing.md)
            }
            ForEach(nodes) { node in
              Button { open(WorkflowRunRoute(environmentId: section.id, runId: node.run.runId)) } label: {
                WorkflowRunRow(node: node)
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("workflows.run")
            }
            if shown == .all, section.skipped > 0 {
              let showing = showSkipped.contains(section.id)
              Button(showing ? String(localized: "Hide skipped") : String(localized: "Show \(section.skipped) skipped")) {
                if showing { showSkipped.remove(section.id) } else { showSkipped.insert(section.id) }
              }
              .font(Typography.footnote)
              .frame(maxWidth: .infinity)
            }
          } header: {
            if workflows.computers.count > 1 { Text(section.label) }
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(Palette.canvas)
    .motion(Motion.micro, value: shown)
    .overlay {
      if sections.isEmpty {
        if workflows.isSettled {
          ContentUnavailableView {
            Label("No workflow runs yet", systemImage: "point.3.connected.trianglepath.dotted")
          } description: {
            Text(
              "A workflow ties agents, code, schedules and questions to you into one run that survives restarts. Write one on your computer, under Workflows, then Definitions."
            )
          }
        } else {
          ProgressView()
        }
      }
    }
  }
}

/// A run in the list: its workflow, state, title and what it is at.
struct WorkflowRunRow: View {
  let node: WorkflowRunNode

  var body: some View {
    let state = Workflows.state(node)
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(spacing: Spacing.sm) {
        WorkflowChip(name: node.run.workflow)
        Text(node.run.workflow)
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
        Spacer(minLength: Spacing.sm)
        WorkflowStateWord(state: state)
      }
      Text(node.run.title)
        .font(Typography.body.weight(.medium))
        .foregroundStyle(Palette.textPrimary)
        .lineLimit(2)
      HStack(spacing: Spacing.sm) {
        Text(WorkflowCopy.now(Workflows.now(node)))
          .lineLimit(1)
        Spacer(minLength: Spacing.sm)
        Text(WorkflowCopy.relative(node.run.updatedAt))
      }
      .font(Typography.caption)
      .foregroundStyle(Palette.textSecondary)
    }
    .padding(.vertical, Spacing.xs)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text("\(node.run.title), \(WorkflowCopy.word(state.word))"))
    .accessibilityHint(Text(WorkflowCopy.now(Workflows.now(node))))
    .accessibilityAddTraits(.isButton)
  }
}
