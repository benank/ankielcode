import AnkielKit
import AppIntents
import Foundation

/// Hands entries from intents and quick actions to the app model. An intent can run before the
/// model exists (a cold launch from Siri), so the latest entry waits here until it attaches.
@MainActor
final class AppEntryInbox {
  static let shared = AppEntryInbox()

  private var pending: AppEntry?
  private var handler: ((AppEntry) -> Void)?

  func deliver(_ entry: AppEntry) {
    if let handler { handler(entry) } else { pending = entry }
  }

  func attach(_ handler: @escaping (AppEntry) -> Void) {
    self.handler = handler
    if let pending {
      self.pending = nil
      handler(pending)
    }
  }
}

/// A recent thread, as the Open thread intent offers it. Read from the device's recent list,
/// never from a connection, so Siri answers at once and offline.
struct ThreadEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Thread"
  static let defaultQuery = ThreadEntityQuery()

  /// `ThreadRef.key` (`<environmentId>:<threadId>`).
  let id: String
  let title: String
  let computer: String?

  init(_ entry: RecentThreads.Entry) {
    id = entry.id
    title = entry.title
    computer = entry.environmentLabel
  }

  var displayRepresentation: DisplayRepresentation {
    if let computer {
      DisplayRepresentation(title: "\(title)", subtitle: "\(computer)")
    } else {
      DisplayRepresentation(title: "\(title)")
    }
  }

  var ref: ThreadRef? {
    guard let split = id.firstIndex(of: ":") else { return nil }
    return ThreadRef(environmentId: String(id[..<split]), threadId: String(id[id.index(after: split)...]))
  }
}

struct ThreadEntityQuery: EntityStringQuery {
  private var recents: [RecentThreads.Entry] { ShortcutStore().recents.donated }

  func entities(for identifiers: [String]) async throws -> [ThreadEntity] {
    let entries = recents
    return identifiers.compactMap { id in entries.first { $0.id == id }.map(ThreadEntity.init) }
  }

  func suggestedEntities() async throws -> [ThreadEntity] {
    recents.map(ThreadEntity.init)
  }

  func entities(matching string: String) async throws -> [ThreadEntity] {
    RecentThreads.matching(string, in: recents).map(ThreadEntity.init)
  }
}

/// A project on a saved computer, from the last shell the app held.
struct ProjectEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
  static let defaultQuery = ProjectEntityQuery()

  let id: String
  let environmentId: String
  let projectId: String
  let title: String
  let computer: String

  init(_ project: ShortcutStore.Project) {
    id = project.id
    environmentId = project.environmentId
    projectId = project.projectId
    title = project.title
    computer = project.environmentLabel
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(computer)")
  }
}

struct ProjectEntityQuery: EntityStringQuery {
  private var projects: [ShortcutStore.Project] { ShortcutStore().projects }

  func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
    let projects = projects
    return identifiers.compactMap { id in projects.first { $0.id == id }.map(ProjectEntity.init) }
  }

  func suggestedEntities() async throws -> [ProjectEntity] {
    projects.map(ProjectEntity.init)
  }

  func entities(matching string: String) async throws -> [ProjectEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return projects.map(ProjectEntity.init) }
    return projects.filter { "\($0.title) \($0.environmentLabel)".localizedStandardContains(query) }.map(ProjectEntity.init)
  }
}

struct NewThreadIntent: AppIntent {
  static let title: LocalizedStringResource = "New thread"
  static let description = IntentDescription("Starts a new thread, optionally with a prompt.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "Prompt", inputOptions: String.IntentInputOptions(multiline: true))
  var prompt: String?

  @Parameter(title: "Project")
  var project: ProjectEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("New thread in \(\.$project)") {
      \.$prompt
    }
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    let text = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
    AppEntryInbox.shared.deliver(
      .newThread(
        prompt: text?.isEmpty == false ? String(text!.prefix(AppEntry.maxPromptLength)) : nil,
        environmentId: project?.environmentId, projectId: project?.projectId))
    return .result()
  }
}

struct OpenThreadIntent: AppIntent {
  static let title: LocalizedStringResource = "Open thread"
  static let description = IntentDescription("Opens one of your recent threads.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "Thread")
  var thread: ThreadEntity

  @MainActor
  func perform() async throws -> some IntentResult {
    if let ref = thread.ref { AppEntryInbox.shared.deliver(.thread(ref)) }
    return .result()
  }
}

struct SearchThreadsIntent: AppIntent {
  static let title: LocalizedStringResource = "Search threads"
  static let description = IntentDescription("Opens the thread list with search ready.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "Search")
  var query: String?

  @MainActor
  func perform() async throws -> some IntentResult {
    AppEntryInbox.shared.deliver(.search(query))
    return .result()
  }
}

struct AnkielAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: NewThreadIntent(),
      phrases: [
        "New thread in \(.applicationName)",
        "Start a new thread in \(.applicationName)",
      ],
      shortTitle: "New thread",
      systemImageName: "square.and.pencil")
    AppShortcut(
      intent: OpenThreadIntent(),
      phrases: [
        "Open a thread in \(.applicationName)",
        "Open \(\.$thread) in \(.applicationName)",
      ],
      shortTitle: "Open thread",
      systemImageName: "bubble.left.and.text.bubble.right")
    AppShortcut(
      intent: SearchThreadsIntent(),
      phrases: ["Search threads in \(.applicationName)"],
      shortTitle: "Search threads",
      systemImageName: "magnifyingglass")
  }
}
