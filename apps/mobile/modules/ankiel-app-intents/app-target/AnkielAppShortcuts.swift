import AppIntents
import Foundation

// Copied into the app target by plugins/withIosAppShortcuts.cjs: Apple's App Intents metadata
// extraction does not see intents compiled into static pods. These keys are shared with
// modules/ankiel-app-intents/ios/AnkielAppIntentsInbox.swift.
private let recentThreadsDefaultsKey = "AnkielAppIntents.recentThreads"
private let openPathNotification = Notification.Name("AnkielAppIntents.openPath")

private struct DonatedThread: Decodable {
  let path: String
  let title: String
}

private func openAppPath(_ path: String) {
  NotificationCenter.default.post(name: openPathNotification, object: nil, userInfo: ["path": path])
}

struct AnkielThreadEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Thread"
  static let defaultQuery = AnkielThreadQuery()

  /// The app path that opens the thread.
  let id: String
  let title: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)")
  }

  /// The recent threads the app donated, the same list its Spotlight entries come from.
  static func donated() -> [AnkielThreadEntity] {
    guard let data = UserDefaults.standard.data(forKey: recentThreadsDefaultsKey),
      let threads = try? JSONDecoder().decode([DonatedThread].self, from: data)
    else {
      return []
    }
    return threads.map { AnkielThreadEntity(id: $0.path, title: $0.title) }
  }
}

struct AnkielThreadQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [AnkielThreadEntity] {
    let threads = AnkielThreadEntity.donated()
    return identifiers.compactMap { id in threads.first { $0.id == id } }
  }

  func suggestedEntities() async throws -> [AnkielThreadEntity] {
    AnkielThreadEntity.donated()
  }

  func entities(matching string: String) async throws -> [AnkielThreadEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    let threads = AnkielThreadEntity.donated()
    guard !query.isEmpty else { return threads }
    return threads.filter { $0.title.localizedStandardContains(query) }
  }
}

struct OpenNewTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "New task"
  static let description = IntentDescription("Starts a new task.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    openAppPath("/new")
    return .result()
  }
}

struct OpenThreadIntent: AppIntent {
  static let title: LocalizedStringResource = "Open thread"
  static let description = IntentDescription("Opens one of your recent threads.")
  static let openAppWhenRun = true

  @Parameter(title: "Thread")
  var thread: AnkielThreadEntity

  @MainActor
  func perform() async throws -> some IntentResult {
    openAppPath(thread.id)
    return .result()
  }
}

struct AnkielAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenNewTaskIntent(),
      phrases: [
        "New task in \(.applicationName)",
        "Start a new task in \(.applicationName)",
      ],
      shortTitle: "New task",
      systemImageName: "square.and.pencil"
    )
    AppShortcut(
      intent: OpenThreadIntent(),
      phrases: [
        "Open a thread in \(.applicationName)",
        "Open an \(.applicationName) thread",
      ],
      shortTitle: "Open thread",
      systemImageName: "bubble.left.and.text.bubble.right"
    )
  }
}
