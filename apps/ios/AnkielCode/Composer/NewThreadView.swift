import AnkielKit
import SwiftUI

/// New thread (RN `NewTaskDraftScreen`): pick the computer (when there is more than one) and the
/// project (recent first, or "No project"), write the first message in the same composer, and
/// send. The thread id is minted here, so the app opens the thread at once with the message
/// pending while `orchestration.launchThread` runs. Worktree and branch choices are not offered
/// yet; threads start in the project folder.
struct NewThreadView: View {
  @Environment(AppModel.self) private var model
  @Environment(PushCoordinator.self) private var push
  @Environment(\.dismiss) private var dismiss
  @State private var preparing = false
  @State private var failure: String?

  private var store: ComposerStore { model.composer }
  private var draft: ComposerDraft { store.draft(ComposerTarget.newThreadKey) }

  /// Every computer the thread could start on.
  private var computers: [Computer] {
    var list = model.registry.environments.map { environment in
      Computer(
        id: environment.id, label: environment.label, connected: model.composerSink?.canSend(to: environment.id) ?? false,
        projects: Self.projects(environment.shell, scratchRoot: environment.scratchWorkspaceRoot),
        scratchProjectId: Self.scratchProject(environment.shell, scratchRoot: environment.scratchWorkspaceRoot),
        offersNoProject: environment.scratchWorkspaceRoot != nil, providers: environment.providers, settings: environment.settings)
    }
    #if DEBUG
      if model.isComposerFake {
        list.insert(
          Computer(
            id: ThreadDebug.environmentId, label: DebugCatalog.environmentLabel, connected: true, projects: DebugCatalog.projects,
            scratchProjectId: "fx-scratch", offersNoProject: true, providers: DebugCatalog.providers, settings: ServerSettings()), at: 0)
      }
    #endif
    return list
  }

  private var computer: Computer? {
    let list = computers
    return list.first { $0.id == draft.environmentId } ?? list.first(where: \.connected) ?? list.first
  }

  private var project: ProjectShell? {
    guard let computer, draft.noProject != true || !computer.offersNoProject else { return nil }
    if let chosen = computer.projects.first(where: { $0.id == draft.projectId }) { return chosen }
    let preferences = model.preferences.values
    if preferences.useLastProjectForNewThreads {
      // The project this device last started a thread in, else the computer's most recent one.
      return computer.projects.first { $0.id == preferences.lastProjectIds[computer.id] } ?? computer.projects.first
    }
    // "Use last project" off: nothing is preselected where "No project" exists.
    return computer.offersNoProject ? nil : computer.projects.first
  }

  private var target: ComposerTarget {
    var target = ComposerTarget(draftKey: ComposerTarget.newThreadKey, environmentId: computer?.id, environmentLabel: computer?.label)
    target.providers = computer?.providers ?? []
    target.settings = computer?.settings ?? ServerSettings()
    target.projectDefault = project?.defaultModelSelection
    target.connected = computer?.connected ?? false
    target.canSend = computer != nil && !preparing
    if let computer, let project {
      target.fileContext = FileContext(environmentId: computer.id, cwd: project.workspaceRoot, threadId: nil, title: project.title)
      target.canReadFiles = model.registry.environment(computer.id)?.allows("filesystem:read") ?? true
    }
    return target
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: Spacing.lg) {
        Spacer(minLength: 0)
        Text("What should we work on?")
          .font(Typography.title)
          .foregroundStyle(Palette.textPrimary)
          .multilineTextAlignment(.center)
        contextChips
        if let failure {
          Text(failure)
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
            .multilineTextAlignment(.center)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Spacing.xl)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.canvas)
      .contentShape(.rect)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if computer == nil {
          Text("Pair a computer to start a thread.")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .padding(.bottom, Spacing.lg)
        } else {
          ComposerView(target: target, placeholder: "Describe a task", send: { _ in Task { await start() } }, focusOnAppear: true)
        }
      }
      .navigationTitle("New thread")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close", systemImage: "xmark") { dismiss() }
            .keyboardShortcut(.cancelAction)
        }
        ToolbarItem(placement: .primaryAction) {
          ProjectFilesButton(environmentId: computer?.id, project: project)
        }
      }
    }
  }

  // MARK: Context

  private var contextChips: some View {
    HStack(spacing: Spacing.sm) {
      if computers.count > 1, let computer {
        Menu {
          ForEach(computers) { option in
            Button {
              store.updateDraft(ComposerTarget.newThreadKey) {
                $0.environmentId = option.id
                $0.projectId = nil
                $0.modelSelection = nil
              }
            } label: {
              Label(option.label, systemImage: option.id == computer.id ? "checkmark" : (option.connected ? "desktopcomputer" : "wifi.slash"))
            }
          }
        } label: {
          ContextChip(systemImage: "desktopcomputer", text: computer.label, dimmed: !computer.connected)
        }
        .accessibilityLabel(Text("Computer"))
        .accessibilityValue(Text(computer.label))
        .accessibilityIdentifier("newThread.computer")
      }
      Menu {
        if let computer {
          Section("Recent projects") {
            ForEach(computer.projects) { option in
              Button {
                store.updateDraft(ComposerTarget.newThreadKey) {
                  $0.projectId = option.id
                  $0.noProject = nil
                }
              } label: {
                Label(option.title, systemImage: option.id == project?.id ? "checkmark" : "folder")
              }
            }
          }
          // Servers with project-less threads turned off send no `scratchWorkspaceRoot` (RN hides it too).
          if computer.offersNoProject {
            Button {
              store.updateDraft(ComposerTarget.newThreadKey) { $0.noProject = true }
            } label: {
              Label("No project", systemImage: draft.noProject == true ? "checkmark" : "tray")
            }
          }
        }
      } label: {
        ContextChip(systemImage: project == nil ? "tray" : "folder", text: project?.title ?? String(localized: "No project"))
      }
      .accessibilityLabel(Text("Project"))
      .accessibilityValue(Text(project?.title ?? String(localized: "No project")))
      .accessibilityIdentifier("newThread.project")
    }
  }

  // MARK: Sending

  private func start() async {
    guard let computer, !preparing else { return }
    let selection = target.selection(draft, sticky: store.memory.lastModelSelection)
    guard let selection else {
      failure = String(localized: "Choose a model first.")
      return
    }
    failure = nil
    var projectId = project?.id
    if projectId == nil {
      projectId = computer.scratchProjectId
      if projectId == nil, !model.isComposerFake {
        preparing = true
        defer { preparing = false }
        do {
          projectId = try await model.registry.ensureScratchProject(in: computer.id)
        } catch {
          // The server says why (for example, project-less threads are off on this computer).
          if case .rejected(let message?, _) = error, !message.isEmpty {
            failure = message
          } else {
            failure = String(localized: "The folder for threads without a project could not be created.")
          }
          return
        }
      }
    }
    guard let projectId else { return }
    let ref = ThreadRef(environmentId: computer.id, threadId: UUID().uuidString.lowercased())
    let current = draft
    let title = ThreadTitleSeed.make(
      text: current.text, attachments: current.attachments.map { $0.chatAttachment(id: $0.id) }, labels: .localized)
    let runtime = target.runtimeMode(current, sticky: store.memory.lastRuntimeMode)
    let sent = store.send(
      ComposerTarget.newThreadKey, to: ref, delivery: .start,
      thread: .init(modelSelection: selection, runtimeMode: runtime, interactionMode: nil),
      creation: .init(projectId: projectId, title: title))
    guard sent != nil else { return }
    if project != nil { model.preferences.values.lastProjectIds[computer.id] = projectId }
    model.navigator.open(ref)
    push.newThreadStarted()
  }

  // MARK: Projects

  struct Computer: Identifiable {
    var id: String
    var label: String
    var connected: Bool
    var projects: [ProjectShell]
    var scratchProjectId: String?
    /// The server allows threads without a project (`config.scratchWorkspaceRoot`).
    var offersNoProject: Bool
    var providers: [ServerProvider]
    var settings: ServerSettings
  }

  /// Projects, most recently used first; archived and the scratch project are left out.
  static func projects(_ shell: ShellState, scratchRoot: String?) -> [ProjectShell] {
    guard let snapshot = shell.snapshot else { return [] }
    var latest: [String: WireTimestamp] = [:]
    for thread in snapshot.threads {
      if let current = latest[thread.projectId], current >= thread.updatedAt { continue }
      latest[thread.projectId] = thread.updatedAt
    }
    return snapshot.projects
      .filter { $0.archivedAt == nil && $0.workspaceRoot != scratchRoot }
      .sorted { lhs, rhs in
        let l = latest[lhs.id] ?? lhs.updatedAt
        let r = latest[rhs.id] ?? rhs.updatedAt
        return l != r ? l > r : lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
      }
  }

  static func scratchProject(_ shell: ShellState, scratchRoot: String?) -> String? {
    guard let scratchRoot else { return nil }
    return shell.snapshot?.projects.first { $0.workspaceRoot == scratchRoot }?.id
  }
}

private struct ContextChip: View {
  let systemImage: String
  let text: String
  var dimmed = false

  var body: some View {
    HStack(spacing: Spacing.xs + 2) {
      Image(systemName: systemImage)
        .foregroundStyle(Palette.textSecondary)
      Text(text)
        .foregroundStyle(dimmed ? Palette.textSecondary : Palette.textPrimary)
        .lineLimit(1)
      Image(systemName: "chevron.down")
        .font(Typography.caption2.weight(.semibold))
        .foregroundStyle(Palette.textTertiary)
    }
    .font(Typography.subheadline.weight(.medium))
    .padding(.horizontal, Spacing.md)
    .frame(minHeight: 44)
    .glassEffect(.regular.interactive(), in: .capsule)
  }
}

extension ThreadTitleSeed.Labels {
  static var localized: ThreadTitleSeed.Labels {
    var labels = ThreadTitleSeed.Labels()
    labels.attachedImage = String(localized: "Attached image")
    labels.attachedImages = String(localized: "Attached images")
    labels.file = { String(localized: "File: \($0)") }
    labels.newThread = String(localized: "New thread")
    return labels
  }
}
