import AnkielKit
import SwiftUI

/// New or edit scheduled task (RN `SettingsScheduledTaskEditorScreen`): what to run, where, and
/// when. Webhook schedules show but are edited on the computer; binding to an existing thread is
/// not offered (a bound task keeps its thread).
struct ScheduledTaskEditor: View {
  let editing: ScheduledTaskEditing
  let tasks: ScheduledTasksModel
  let registry: EnvironmentRegistry
  let onSaved: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var environmentId: String
  @State private var draft: ScheduledTaskDraft
  @State private var initial: ScheduledTaskDraft
  @State private var saving = false
  @State private var problem: (title: String, message: String)?
  @State private var confirmingDiscard = false

  init(editing: ScheduledTaskEditing, tasks: ScheduledTasksModel, registry: EnvironmentRegistry, onSaved: @escaping () -> Void) {
    self.editing = editing
    self.tasks = tasks
    self.registry = registry
    self.onSaved = onSaved
    let environment = registry.environment(editing.environmentId)
    let draft =
      editing.task.map(ScheduledTaskDraft.init(editing:))
      ?? Self.newDraft(environment: environment, fixtureProjects: ScheduledTasksDebug.projects)
    _environmentId = State(initialValue: editing.environmentId)
    _draft = State(initialValue: draft)
    _initial = State(initialValue: draft)
  }

  static func newDraft(environment: EnvironmentModel?, fixtureProjects: [ProjectShell]?) -> ScheduledTaskDraft {
    let project = fixtureProjects?.first ?? environment?.shell.snapshot?.projects.first
    let model =
      project?.defaultModelSelection ?? environment?.settings.defaultModelSelection
      ?? environment?.providers.first(where: \.enabled).flatMap { provider in
        (provider.models.first(where: \.isDefault) ?? provider.models.first).map { ModelSelection(instanceId: provider.instanceId, model: $0.slug) }
      } ?? ScheduledTasksDebug.modelSelection
    var draft = ScheduledTaskDraft(projectId: project?.id, modelSelection: model)
    ScheduledTasksDebug.preset(&draft, environment: environment)
    return draft
  }

  private var environment: EnvironmentModel? { registry.environment(environmentId) }
  private var projects: [ProjectShell] { ScheduledTasksDebug.projects ?? environment?.shell.snapshot?.projects ?? [] }
  private var timeZone: String? { tasks.computers.first { $0.id == environmentId }?.list?.timeZone }
  private var canSave: Bool { tasks.canOperate(environmentId) && !saving }
  private var changed: Bool { draft != initial || environmentId != editing.environmentId }

  var body: some View {
    NavigationStack {
      Form {
        if editing.task == nil, tasks.computers.count > 1 {
          Picker("Runs on", selection: $environmentId) {
            ForEach(tasks.computers) { Text($0.label).tag($0.id) }
          }
        }
        if !tasks.canOperate(environmentId) {
          Text(environment?.status.isConnected == false
            ? String(localized: "This environment is disconnected. Reconnect before saving.")
            : String(localized: "This connection can read tasks but not change them."))
            .font(.footnote)
            .foregroundStyle(Palette.attention)
        }
        Section(String(localized: "Task", comment: "section heading for a scheduled task")) {
          TextField("Name", text: $draft.title, prompt: Text("Check for issues"))
            .accessibilityIdentifier("scheduledTask.name")
          TextField("Prompt", text: $draft.prompt, axis: .vertical)
            .lineLimit(3...10)
            .accessibilityIdentifier("scheduledTask.prompt")
        }
        Section(String(localized: "Context", comment: "section heading: project and model")) {
          Picker("Project", selection: $draft.projectId) {
            if draft.projectId == nil { Text("Choose project").tag(String?.none) }
            if let id = draft.projectId, !projects.contains(where: { $0.id == id }) { Text(id).tag(Optional(id)) }
            ForEach(projects) { Text($0.title).tag(Optional($0.id)) }
          }
          modelPicker
        }
        workspaceSection
        scheduleSection
        Section {
          Toggle(String(localized: "Enabled", comment: "switch label, whether the task runs"), isOn: $draft.enabled)
            .accessibilityLabel(Text("Task enabled"))
        }
      }
      .navigationTitle(editing.task == nil ? String(localized: "New scheduled task") : String(localized: "Edit scheduled task"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { if changed { confirmingDiscard = true } else { dismiss() } }
            .disabled(saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(editing.task == nil ? String(localized: "Create", comment: "button, create a scheduled task") : String(localized: "Save", comment: "button, save a scheduled task")) { save() }
            .disabled(!canSave)
            .accessibilityIdentifier("scheduledTask.save")
        }
      }
      .overlay { if saving { ProgressView().controlSize(.large) } }
      .confirmationDialog("Discard changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
        Button("Discard changes", role: .destructive) { dismiss() }
        Button("Keep editing", role: .cancel) {}
      } message: {
        Text("Your unsaved changes will be lost.")
      }
      .alert(problem?.title ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(problem?.message ?? "")
      }
      .interactiveDismissDisabled(changed || saving)
      .onChange(of: environmentId) { _, _ in
        if editing.task == nil { draft = Self.newDraft(environment: environment, fixtureProjects: ScheduledTasksDebug.projects) }
      }
    }
  }

  // MARK: Sections

  private struct ModelChoice: Identifiable, Hashable {
    let selection: ModelSelection
    let label: String
    var id: String { "\(selection.instanceId)/\(selection.model)" }
  }

  private var modelChoices: [ModelChoice] {
    var choices = (environment?.providers ?? []).filter(\.enabled).flatMap { provider in
      provider.models.filter { !$0.isLegacy }.map {
        ModelChoice(
          selection: ModelSelection(instanceId: provider.instanceId, model: $0.slug),
          label: "\(provider.displayName ?? provider.instanceId) · \($0.shortName ?? $0.name)")
      }
    }
    if let current = draft.modelSelection, !choices.contains(where: { $0.id == "\(current.instanceId)/\(current.model)" }) {
      choices.insert(ModelChoice(selection: current, label: "\(current.instanceId) · \(current.model)"), at: 0)
    }
    return choices
  }

  private var modelPicker: some View {
    let choices = modelChoices
    return Picker("Model", selection: Binding(
      get: { draft.modelSelection.map { "\($0.instanceId)/\($0.model)" } ?? "" },
      set: { id in
        guard let choice = choices.first(where: { $0.id == id }) else { return }
        // Options belong to the model they were picked for.
        draft.modelSelection = choice.selection.model == draft.modelSelection?.model && choice.selection.instanceId == draft.modelSelection?.instanceId
          ? draft.modelSelection : choice.selection
      }
    )) {
      if draft.modelSelection == nil { Text("Choose model").tag("") }
      ForEach(choices) { Text($0.label).tag($0.id) }
    }
  }

  private var workspaceSection: some View {
    Section("Workspace") {
      Picker("Run in", selection: $draft.workspace) {
        Text("New worktree").tag(ScheduledTaskDraft.Workspace.worktree)
        Text("Project checkout").tag(ScheduledTaskDraft.Workspace.root)
        Text("Specific checkout").tag(ScheduledTaskDraft.Workspace.existingWorktree)
      }
      switch draft.workspace {
      case .worktree:
        LabeledContent("Base branch") {
          TextField("Base branch", text: $draft.baseRef, prompt: Text("Automatic"))
            .multilineTextAlignment(.trailing)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
      case .existingWorktree:
        LabeledContent("Checkout path") {
          TextField("Checkout path", text: $draft.checkoutPath, prompt: Text(verbatim: "/path/to/checkout"))
            .multilineTextAlignment(.trailing)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
      case .root:
        EmptyView()
      }
    }
  }

  private var scheduleSection: some View {
    Section {
      if draft.schedule.mode == .webhook {
        LabeledContent("Runs", value: String(localized: "On webhook"))
        if let task = editing.task, let path = task.webhookURL ?? task.webhookPath {
          LabeledContent(task.webhookURL == nil ? String(localized: "Webhook path") : String(localized: "Webhook URL")) {
            Text(path).textSelection(.enabled).font(.footnote.monospaced()).lineLimit(2)
          }
        }
        Text("Webhook settings are edited on the computer.")
          .font(.footnote)
          .foregroundStyle(Palette.textSecondary)
      } else {
        Picker("Schedule", selection: $draft.schedule.mode) {
          Text("At a time").tag(ScheduleDraft.Mode.fixedTime)
          Text("Once", comment: "one-time schedule option").tag(ScheduleDraft.Mode.once)
          Text("Interval").tag(ScheduleDraft.Mode.interval)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("scheduledTask.mode")
        switch draft.schedule.mode {
        case .fixedTime: fixedTime
        case .once:
          DatePicker(
            "Date", selection: Binding(get: { draft.schedule.runAt ?? .now.addingTimeInterval(3600) }, set: { draft.schedule.runAt = $0 }),
            in: Date.now..., displayedComponents: [.date, .hourAndMinute])
            .onAppear { if draft.schedule.runAt == nil { draft.schedule.runAt = .now.addingTimeInterval(3600) } }
        case .interval:
          LabeledContent("Minutes between runs") {
            TextField("15", text: $draft.schedule.intervalMinutes)
              .keyboardType(.decimalPad)
              .multilineTextAlignment(.trailing)
              .frame(maxWidth: 100)
              .accessibilityIdentifier("scheduledTask.interval")
          }
        case .webhook:
          EmptyView()
        }
      }
    } header: {
      Text("Schedule", comment: "noun, section heading")
    } footer: {
      if draft.schedule.mode == .fixedTime, let zone = ScheduledTasks.timeZoneLabel(timeZone) {
        Text("Times are in \(zone), the computer's time zone.")
      }
    }
  }

  @ViewBuilder private var fixedTime: some View {
    DatePicker(
      String(localized: "Time", comment: "time of day"),
      selection: Binding(
        get: { ScheduledTaskCopy.date(timeOfDay: draft.schedule.timeOfDay) ?? .now },
        set: { draft.schedule.timeOfDay = ScheduledTaskCopy.timeOfDay($0) }),
      displayedComponents: .hourAndMinute)
    Picker(String(localized: "Repeat", comment: "noun, which days a task repeats on"), selection: Binding(
      get: { draft.schedule.weekdays.count == 7 ? "daily" : ScheduledTasks.isWeekdays(draft.schedule.weekdays) ? "weekdays" : "custom" },
      set: { value in
        switch value {
        case "daily": draft.schedule.weekdays = Set(0...6)
        case "weekdays": draft.schedule.weekdays = [1, 2, 3, 4, 5]
        default: break
        }
      }
    )) {
      Text("Every day").tag("daily")
      Text("Weekdays").tag("weekdays")
      Text("Custom", comment: "repeat option: chosen days").tag("custom")
    }
    HStack(spacing: Spacing.xs) {
      ForEach(Self.weekOrder, id: \.self) { day in
        let on = draft.schedule.weekdays.contains(day)
        Button {
          if on { draft.schedule.weekdays.remove(day) } else { draft.schedule.weekdays.insert(day) }
        } label: {
          Text(String(ScheduledTaskCopy.weekday(day).prefix(2)))
            .font(.footnote.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 36)
            .foregroundStyle(on ? Palette.onPrimaryButton : Palette.textPrimary)
            .background(on ? Palette.primaryButton : Palette.fill, in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(Calendar.current.weekdaySymbols[day]))
        .accessibilityAddTraits(on ? .isSelected : [])
      }
    }
    .padding(.vertical, Spacing.xxs)
  }

  /// The week in the device's order (Monday first where that is the custom).
  private static var weekOrder: [Int] {
    let first = Calendar.current.firstWeekday - 1
    return (0..<7).map { (first + $0) % 7 }
  }

  // MARK: Save

  private func save() {
    guard !saving else { return }
    if case .once = draft.schedule.mode, let runAt = draft.schedule.runAt, runAt < .now {
      problem = (String(localized: "Incomplete task"), String(localized: "Pick a time in the future."))
      return
    }
    guard let projectId = draft.projectId, projects.contains(where: { $0.id == projectId }) || projects.isEmpty else {
      problem = (String(localized: "Project unavailable"), String(localized: "Choose a project in this environment."))
      return
    }
    let root = projects.first { $0.id == projectId }?.workspaceRoot
    saving = true
    Task {
      defer { saving = false }
      let refs = draft.workspace == .worktree && draft.baseRef.trimmingCharacters(in: .whitespaces).isEmpty
        ? await root.asyncMap { await tasks.sink.branches(cwd: $0, environmentId: environmentId) } ?? [] : []
      switch draft.upsert(refs: refs) {
      case .failure:
        problem = (
          String(localized: "Incomplete task"),
          String(localized: "Add a name, prompt, project, model, valid schedule, and checkout path if needed.")
        )
      case .success(let input):
        do {
          let task = try await tasks.sink.upsert(input, environmentId: environmentId)
          tasks.saved(task, environmentId: environmentId)
          onSaved()
          dismiss()
        } catch {
          problem = (String(localized: "Could not save task"), WorkflowCopy.describe(EnvironmentRequestError(error)))
        }
      }
    }
  }
}

extension Optional {
  fileprivate func asyncMap<T>(_ transform: (Wrapped) async -> T) async -> T? {
    guard let self else { return nil }
    return await transform(self)
  }
}
