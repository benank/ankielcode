import AnkielKit
import SwiftUI

/// Which terminal the thread shows; `nil` opens the thread's running one (RN's bootstrap).
struct TerminalRoute: Hashable, Identifiable {
  var terminalId: String?
  var id: String { terminalId ?? "" }
}

/// A thread's terminals: the computer's terminal list while the thread is on screen, and the
/// pushed terminal screen. Everything is hidden without `terminal:operate` (RN shows a read-only
/// observer with `terminal:read` alone; that is not built here).
@MainActor @Observable
final class TerminalPresenter {
  let ref: ThreadRef
  let directory: TerminalDirectory
  let host: EnvironmentTerminalHost
  var route: TerminalRoute?
  @ObservationIgnored private let registry: EnvironmentRegistry
  @ObservationIgnored var projectId: () -> String? = { nil }

  init(ref: ThreadRef, registry: EnvironmentRegistry) {
    self.ref = ref
    self.registry = registry
    host = EnvironmentTerminalHost(registry: registry, environmentId: ref.environmentId)
    directory = TerminalDirectory(host: host)
  }

  private var environment: EnvironmentModel? { registry.environment(ref.environmentId) }

  /// The project's root and the thread's worktree (RN `resolveTerminalOpenLocation` inputs).
  var workspace: (root: String, worktree: String?, title: String)? {
    guard let environment else { return nil }
    let thread = environment.shell.threads.first { $0.id == ref.threadId }
    let projectId = projectId() ?? thread?.projectId
    guard let project = environment.shell.snapshot?.projects.first(where: { $0.id == projectId }) else { return nil }
    return (project.workspaceRoot, thread?.worktreePath, project.title)
  }

  /// A known answer is required, as for settings (RN `useEnvironmentScope`).
  var canOperate: Bool { environment?.holds(TerminalScope.operate) ?? false }
  var canOpen: Bool { canOperate && workspace != nil }
  var readable: Bool { environment?.holds(TerminalScope.read) == true }
  var isConnected: Bool { environment?.activeRoute != nil }

  var entries: [TerminalMenuEntry] { directory.entries(threadId: ref.threadId) }

  func open(_ terminalId: String? = nil) {
    guard canOpen else { return }
    route = TerminalRoute(terminalId: terminalId)
  }

  /// A new shell for this thread; ids get a unique suffix when the list could not be read.
  func newTerminalId(active: String? = nil) -> String {
    let listed = directory.terminals?.filter { $0.threadId == ref.threadId }.map(\.terminalId)
    return TerminalMenu.nextOpenId(
      listed: listed ?? [], active: active, uniqueSuffix: listed == nil ? UUID().uuidString.lowercased() : nil)
  }

  func openNew() {
    open(newTerminalId())
  }

  /// Where a new shell starts: an existing session's folder, else the thread's worktree, else the
  /// project root. Nil until the list says whether this terminal exists.
  func location(for terminalId: String) -> TerminalLocation? {
    guard let workspace else { return nil }
    if let existing = directory.terminals?.first(where: { $0.threadId == ref.threadId && $0.terminalId == terminalId }) {
      return TerminalLocation(cwd: existing.cwd, worktreePath: existing.worktreePath)
    }
    if directory.terminals == nil, environment?.holds(TerminalScope.read) == true { return nil }
    return TerminalLocation(cwd: workspace.worktree ?? workspace.root, worktreePath: workspace.worktree, env: TerminalDebug.env)
  }
}

extension EnvironmentValues {
  @Entry var terminalPresenter: TerminalPresenter?
}

extension View {
  /// Gives a thread screen its terminals: the list while it shows, the Terminal menu, and the
  /// pushed terminal screen.
  func threadTerminal(_ ref: ThreadRef, projectId: String?) -> some View {
    modifier(ThreadTerminalHost(ref: ref, projectId: projectId))
  }
}

private struct ThreadTerminalHost: ViewModifier {
  let ref: ThreadRef
  let projectId: String?
  @Environment(AppModel.self) private var model
  @State private var presenter: TerminalPresenter?

  func body(content: Content) -> some View {
    if ThreadDebug.isFixture(ref) {
      content
    } else {
      let presenter = presenter ?? TerminalPresenter(ref: ref, registry: model.registry)
      content
        .environment(\.terminalPresenter, presenter)
        .navigationDestination(item: Bindable(presenter).route) { route in
          TerminalScreen(presenter: presenter, requested: route.terminalId)
        }
        .onAppear {
          presenter.projectId = { [projectId] in projectId }
          if self.presenter == nil { self.presenter = presenter }
          if presenter.canOperate { presenter.directory.start() }
          TerminalDebug.apply(to: presenter)
        }
        .onChange(of: presenter.canOperate) { _, can in
          if can { presenter.directory.start() } else { presenter.directory.stop() }
        }
        .onDisappear {
          // The pushed terminal keeps the thread screen in the stack, so this is the thread leaving.
          if presenter.route == nil { presenter.directory.stop() }
        }
    }
  }
}

/// "Terminal" in a thread's menu: the thread's live terminals and a new one (RN `threadTerminalMenu`).
struct TerminalMenuSection: View {
  @Environment(\.terminalPresenter) private var presenter

  var body: some View {
    if let presenter, presenter.canOpen {
      let entries = presenter.entries
      Group {
        if entries.isEmpty {
          Button("Terminal", systemImage: "apple.terminal") { presenter.open() }
            .accessibilityIdentifier("thread.terminal")
        } else {
          Menu {
            ForEach(entries) { entry in
              Button {
                presenter.open(entry.terminalId)
              } label: {
                // A sibling Text is the menu row's subtitle; inside the Label it is dropped.
                Label(TerminalCopy.name(entry.name), systemImage: "apple.terminal")
                Text(TerminalCopy.subtitle(entry))
              }
            }
            Button {
              presenter.openNew()
            } label: {
              Label("Open new terminal", systemImage: "plus")
              Text("Start another shell for this thread")
            }
            .accessibilityIdentifier("thread.terminal.new")
          } label: {
            Label("Terminal", systemImage: "apple.terminal")
          }
          .accessibilityIdentifier("thread.terminal")
        }
      }
    }
  }
}

/// RN's terminal copy (`getTerminalStatusLabel`, `getTerminalLabel`).
enum TerminalCopy {
  static func name(_ name: TerminalName) -> String {
    switch name {
    case .process(let label): label
    case .numbered(let number): String(localized: "Terminal \(number)")
    case .id(let id): id
    }
  }

  static func status(_ status: TerminalStatus, running: Bool) -> String {
    switch status {
    case .running: running ? String(localized: "Task running", comment: "terminal status") : String(localized: "Ready", comment: "terminal status")
    case .starting: String(localized: "Starting", comment: "terminal status")
    case .exited: String(localized: "Exited", comment: "terminal status")
    case .error: String(localized: "Error", comment: "terminal status")
    case .closed: String(localized: "Not started", comment: "terminal status")
    }
  }

  static func subtitle(_ entry: TerminalMenuEntry) -> String {
    [status(entry.status, running: entry.hasRunningSubprocess), TerminalMenu.basename(entry.cwd)]
      .compactMap(\.self).joined(separator: " · ")
  }
}
