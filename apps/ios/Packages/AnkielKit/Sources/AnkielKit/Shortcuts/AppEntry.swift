import Foundation

/// Where a system entry point (App Shortcut, Siri, Spotlight, a Home Screen quick action, a
/// keyboard command, a link) asks the app to go. Only these destinations exist: entries outlive
/// app updates, so anything else in a link is ignored (RN `allowedShortcutHref`).
public enum AppEntry: Sendable, Hashable {
  /// The new-thread sheet, optionally with a prompt for its draft and a computer and project.
  case newThread(prompt: String? = nil, environmentId: String? = nil, projectId: String? = nil)
  case thread(ThreadRef)
  /// Home with the search field focused, optionally with a query typed.
  case search(String? = nil)

  public var isThread: Bool {
    if case .thread = self { true } else { false }
  }

  /// Prompts longer than this are cut (a Siri dictation is short; a pasted essay is not a prompt).
  public static let maxPromptLength = 20_000

  /// `ankielcode-native://new?prompt=…&environment=…&project=…`, `…://search?q=…`, and the
  /// thread links `ThreadLink` reads (`…://thread/<environmentId>/<threadId>`).
  public static func parse(_ url: URL) -> AppEntry? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(), scheme.wholeMatch(of: /ankielcode(?:-[a-z]+)?/) != nil
    else { return nil }
    if let ref = ThreadLink.parse(url) { return .thread(ref) }
    let route = [components.host, components.path.trimmingCharacters(in: ["/"])]
      .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: "/")
    func query(_ name: String) -> String? {
      let value = components.queryItems?.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
      return value?.isEmpty == false ? value : nil
    }
    switch route {
    case "new":
      return .newThread(
        prompt: query("prompt").map { String($0.prefix(maxPromptLength)) }, environmentId: query("environment"),
        projectId: query("project"))
    case "search":
      return .search(query("q").map { String($0.prefix(200)) })
    default:
      return nil
    }
  }

  public func url(scheme: String = "ankielcode-native") -> URL {
    var components = URLComponents()
    components.scheme = scheme
    switch self {
    case .newThread(let prompt, let environmentId, let projectId):
      components.host = "new"
      let items = [
        prompt.map { URLQueryItem(name: "prompt", value: $0) }, environmentId.map { URLQueryItem(name: "environment", value: $0) },
        projectId.map { URLQueryItem(name: "project", value: $0) },
      ].compactMap { $0 }
      components.queryItems = items.isEmpty ? nil : items
    case .thread(let ref):
      components.host = "thread"
      components.path = "/\(ref.environmentId)/\(ref.threadId)"
    case .search(let text):
      components.host = "search"
      components.queryItems = text.map { [URLQueryItem(name: "q", value: $0)] }
    }
    return components.url!
  }
}

/// The threads the user opened last, newest first (RN `withRecentThreadShortcut`): the source for
/// quick actions, the Open thread intent's suggestions and Spotlight. Kept on the device so they
/// work from a cold launch without a connection.
public struct RecentThreads: Sendable, Hashable, Codable {
  public struct Entry: Sendable, Hashable, Codable, Identifiable {
    public var environmentId: String
    public var threadId: String
    public var title: String
    /// The computer's name, for Siri and Spotlight to tell two machines apart.
    public var environmentLabel: String?

    public var ref: ThreadRef { ThreadRef(environmentId: environmentId, threadId: threadId) }
    public var id: String { ref.key }

    public init(ref: ThreadRef, title: String, environmentLabel: String? = nil) {
      environmentId = ref.environmentId
      threadId = ref.threadId
      self.title = title
      self.environmentLabel = environmentLabel
    }
  }

  public static let limit = 10

  public private(set) var entries: [Entry]

  public init(entries: [Entry] = []) {
    self.entries = Array(entries.prefix(Self.limit))
  }

  /// Moves an opened thread to the front. An empty title keeps the one already known.
  public func recording(_ opened: Entry) -> RecentThreads {
    let existing = entries.first { $0.id == opened.id }
    var entry = opened
    if entry.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let existing { entry.title = existing.title }
    if entry.environmentLabel == nil { entry.environmentLabel = existing?.environmentLabel }
    return RecentThreads(entries: [entry] + entries.filter { $0.id != opened.id })
  }

  /// Keeps only threads of saved computers.
  public func retaining(environments: Set<String>) -> RecentThreads {
    RecentThreads(entries: entries.filter { environments.contains($0.environmentId) })
  }

  public func removing(_ ref: ThreadRef) -> RecentThreads {
    RecentThreads(entries: entries.filter { $0.ref != ref })
  }

  /// Updates titles from the shell; a thread the shell lists as gone (archived or deleted) leaves.
  public func refreshing(titles: [String: String], removed: Set<String>) -> RecentThreads {
    RecentThreads(entries: entries.compactMap { entry in
      if removed.contains(entry.id) { return nil }
      var entry = entry
      if let title = titles[entry.id], !title.isEmpty { entry.title = title }
      return entry
    })
  }

  /// Titled threads only: an untitled thread has nothing for Siri or Spotlight to match.
  public var donated: [Entry] {
    entries.filter { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  public static func matching(_ query: String, in entries: [Entry]) -> [Entry] {
    let words = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
      .split(separator: " ").map(String.init)
    guard !words.isEmpty else { return entries }
    return entries.filter { entry in
      let haystack = "\(entry.title) \(entry.environmentLabel ?? "")".folding(
        options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
      return words.allSatisfy { haystack.contains($0) }
    }
  }
}

/// The recent threads and projects, saved in `UserDefaults` so intents read them before (or
/// without) the app's connections.
public struct ShortcutStore: Sendable {
  public struct Project: Sendable, Hashable, Codable, Identifiable {
    public var environmentId: String
    public var projectId: String
    public var title: String
    public var environmentLabel: String
    public var id: String { "\(environmentId):\(projectId)" }

    public init(environmentId: String, projectId: String, title: String, environmentLabel: String) {
      self.environmentId = environmentId
      self.projectId = projectId
      self.title = title
      self.environmentLabel = environmentLabel
    }
  }

  static let threadsKey = "ankiel.shortcuts.recentThreads.v1"
  static let projectsKey = "ankiel.shortcuts.projects.v1"

  nonisolated(unsafe) let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public var recents: RecentThreads {
    get { defaults.data(forKey: Self.threadsKey).flatMap { try? JSONDecoder().decode(RecentThreads.self, from: $0) } ?? RecentThreads() }
    nonmutating set { defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.threadsKey) }
  }

  public var projects: [Project] {
    get { defaults.data(forKey: Self.projectsKey).flatMap { try? JSONDecoder().decode([Project].self, from: $0) } ?? [] }
    nonmutating set { defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.projectsKey) }
  }
}
