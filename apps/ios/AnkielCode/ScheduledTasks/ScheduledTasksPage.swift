import AnkielKit
import SwiftUI

/// A task to edit, or a new one.
struct ScheduledTaskEditing: Identifiable {
  let id = UUID()
  var environmentId: String
  var task: ScheduledTask?
}

/// Settings → Scheduled tasks (RN `SettingsScheduledTasksRouteScreen`): each computer's tasks,
/// with pause or resume, run now, delete and edit; a new task from the toolbar.
struct ScheduledTasksPage: View {
  @Environment(AppModel.self) private var model
  @State private var tasks: ScheduledTasksModel?
  @State private var editing: ScheduledTaskEditing?
  @State private var deleting: (task: ScheduledTask, environmentId: String)?
  @State private var failure: String?
  @State private var feedback = 0

  var body: some View {
    Group {
      if let tasks { list(tasks) } else { ProgressView() }
    }
    .navigationTitle("Scheduled tasks")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("New task", systemImage: "plus") {
          if let environmentId = tasks?.computers.first(where: { tasks?.canOperate($0.id) == true })?.id ?? tasks?.computers.first?.id {
            editing = ScheduledTaskEditing(environmentId: environmentId)
          }
        }
        .disabled(tasks?.computers.isEmpty != false)
        .accessibilityIdentifier("scheduledTasks.new")
      }
    }
    .sheet(item: $editing) { editing in
      if let tasks {
        ScheduledTaskEditor(editing: editing, tasks: tasks, registry: model.registry) {
          feedback += 1
        }
      }
    }
    .confirmationDialog(
      "Delete task?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible,
      presenting: deleting
    ) { target in
      Button("Delete", role: .destructive) { act(.delete, target.task, target.environmentId) }
    } message: { target in
      Text(target.task.title)
    }
    .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK", role: .cancel) {}
    }
    .sensoryFeedback(.success, trigger: feedback)
    .onAppear {
      guard tasks == nil else { return }
      let created = ScheduledTasksDebug.model() ?? ScheduledTasksModel(registry: model.registry, sink: model.registry)
      tasks = created
      created.start()
      if let opening = ScheduledTasksDebug.opening(created) { editing = opening }
    }
    .onDisappear { if editing == nil { tasks?.stop() } }
  }

  private func list(_ tasks: ScheduledTasksModel) -> some View {
    ThemedList {
      if tasks.computers.isEmpty {
        ContentUnavailableView(
          "No computers", systemImage: "desktopcomputer",
          description: Text("Connect an environment to view and create scheduled tasks."))
      }
      ForEach(tasks.computers) { computer in
        Section {
          if let error = computer.error, computer.list == nil {
            Text(error).font(Typography.subheadline).foregroundStyle(Palette.danger)
          } else if let list = computer.list {
            if list.tasks.isEmpty {
              Text("No scheduled tasks yet.").foregroundStyle(Palette.textSecondary)
            }
            ForEach(list.tasks) { task in
              row(task, computer: computer, timeZone: list.timeZone, tasks: tasks)
            }
          } else {
            Text("Loading tasks…").foregroundStyle(Palette.textSecondary)
          }
        } header: {
          Label(computer.label, systemImage: "desktopcomputer")
        }
      }
    }
    .listStyle(.insetGrouped)
  }

  private func row(_ task: ScheduledTask, computer: ScheduledTasksModel.Computer, timeZone: String?, tasks: ScheduledTasksModel) -> some View {
    let canOperate = tasks.canOperate(computer.id)
    return Button {
      editing = ScheduledTaskEditing(environmentId: computer.id, task: task)
    } label: {
      HStack(alignment: .top, spacing: Spacing.md) {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
          Text(task.title)
            .foregroundStyle(task.enabled ? Palette.textPrimary : Palette.textSecondary)
            .lineLimit(1)
          Text(ScheduledTaskCopy.summary(task, timeZone: timeZone))
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(2)
          if let error = task.lastRunError {
            Text("Last run failed: \(error)")
              .font(Typography.footnote)
              .foregroundStyle(Palette.danger)
              .lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        if tasks.busy.contains(task.id) { ProgressView() }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("Edit \(task.title)"))
    .accessibilityValue(Text(ScheduledTaskCopy.summary(task, timeZone: timeZone)))
    .accessibilityIdentifier("scheduledTasks.task")
    .swipeActions(edge: .trailing) {
      if canOperate {
        Button("Delete", systemImage: "trash", role: .destructive) { deleting = (task, computer.id) }
        Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play") {
          act(.toggle, task, computer.id)
        }
        .tint(Palette.attention)
      }
    }
    .contextMenu {
      Button("Edit", systemImage: "pencil") { editing = ScheduledTaskEditing(environmentId: computer.id, task: task) }
      if let threadId = task.threadId, task.threadMode != .newThread {
        Button("Open thread", systemImage: "bubble.left.and.text.bubble.right") {
          model.open(.thread(ThreadRef(environmentId: computer.id, threadId: threadId)))
        }
      }
      Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play") { act(.toggle, task, computer.id) }
        .disabled(!canOperate)
      if !task.isWebhook {
        Button("Run now", systemImage: "play.circle") { act(.run, task, computer.id) }
          .disabled(!canOperate)
      }
      Button("Delete", systemImage: "trash", role: .destructive) { deleting = (task, computer.id) }
        .disabled(!canOperate)
    }
  }

  private func act(_ action: ScheduledTasksModel.Action, _ task: ScheduledTask, _ environmentId: String) {
    guard let tasks else { return }
    Task {
      if let error = await tasks.perform(action, on: task, environmentId: environmentId) {
        let title =
          switch action {
          case .run: String(localized: "Could not run task")
          case .toggle: String(localized: "Could not update task")
          case .delete: String(localized: "Could not delete task")
          }
        failure = "\(title): \(error)"
      } else {
        feedback += 1
      }
    }
  }
}
