import AnkielKit
import AppIntents
import CoreSpotlight
import SwiftUI
import UIKit

/// Keeps the system's entry points in step with the app: the recent threads (saved for intents),
/// the Home Screen quick actions and the Spotlight index. Spotlight items use the computer's id as
/// their domain, so removing a computer removes its items.
@MainActor
final class ShortcutPublisher {
  static let shared = ShortcutPublisher()

  private let store = ShortcutStore()
  private var indexed: [String] = []
  private var indexing: Task<Void, Never>?

  enum QuickAction: String {
    case newThread = "com.ankiel.code.native.new-thread"
    case search = "com.ankiel.code.native.search"
    case thread = "com.ankiel.code.native.thread"
  }

  /// A thread was opened.
  func record(_ ref: ThreadRef, model: AppModel) {
    let shell = model.home.thread(ref)
    let label = model.registry.environment(ref.environmentId)?.label
    store.recents = store.recents.recording(.init(ref: ref, title: shell?.title ?? "", environmentLabel: label))
    publish()
  }

  /// The saved computers, their titles and projects changed (a launch, a shell update, a removal).
  func sync(_ model: AppModel) {
    let environments = model.registry.environments
    let ids = Set(environments.map(\.id))
    var titles: [String: String] = [:]
    var removed: Set<String> = []
    for entry in store.recents.entries {
      guard let environment = model.registry.environment(entry.environmentId), let snapshot = environment.shell.snapshot else { continue }
      if let thread = model.home.thread(entry.ref) {
        if thread.archivedAt != nil { removed.insert(entry.id) } else { titles[entry.id] = thread.title }
      } else if environment.shell.status == .live, snapshot.archivedThreads.contains(where: { $0.id == entry.threadId }) {
        removed.insert(entry.id)
      }
    }
    let recents = store.recents.retaining(environments: ids).refreshing(titles: titles, removed: removed)
    let projects = environments.flatMap { environment in
      (environment.shell.snapshot?.projects ?? []).filter { $0.archivedAt == nil }.map {
        ShortcutStore.Project(environmentId: environment.id, projectId: $0.id, title: $0.title, environmentLabel: environment.label)
      }
    }
    // Shells move often while agents work; write and republish only what changed.
    if projects != store.projects { store.projects = projects }
    guard recents != store.recents || !published else { return }
    store.recents = recents
    publish()
  }

  private var published = false

  private func publish() {
    published = true
    let recents = store.recents.donated
    var items = [
      UIApplicationShortcutItem(
        type: QuickAction.newThread.rawValue, localizedTitle: String(localized: "New thread"), localizedSubtitle: nil,
        icon: UIApplicationShortcutIcon(systemImageName: "square.and.pencil")),
      UIApplicationShortcutItem(
        type: QuickAction.search.rawValue, localizedTitle: String(localized: "Search"), localizedSubtitle: nil,
        icon: UIApplicationShortcutIcon(systemImageName: "magnifyingglass")),
    ]
    if let latest = recents.first {
      items.append(
        UIApplicationShortcutItem(
          type: QuickAction.thread.rawValue, localizedTitle: latest.title, localizedSubtitle: latest.environmentLabel,
          icon: UIApplicationShortcutIcon(systemImageName: "bubble.left"),
          userInfo: ["url": AppEntry.thread(latest.ref).url().absoluteString as NSString]))
    }
    UIApplication.shared.shortcutItems = items
    index(recents)
    // The "Open <thread>" phrase lists the recent threads; Siri re-reads them only when told.
    AnkielAppShortcuts.updateAppShortcutParameters()
  }

  /// Replaces the index after the previous replacement finishes, so a late delete never wipes a
  /// newer list.
  private func index(_ recents: [RecentThreads.Entry]) {
    let identifiers = recents.map { "\($0.id)|\($0.title)|\($0.environmentLabel ?? "")" }
    guard identifiers != indexed else { return }
    let domains = Array(Set(indexed.compactMap { $0.split(separator: ":").first.map(String.init) } + recents.map(\.environmentId)))
    indexed = identifiers
    let previous = indexing
    // Off the main actor: the index standardizes items synchronously before it sends them.
    indexing = Task.detached(priority: .utility) {
      await previous?.value
      let items = recents.map(Self.item)
      let index = CSSearchableIndex.default()
      try? await index.deleteSearchableItems(withDomainIdentifiers: domains)
      guard !items.isEmpty else { return }
      do {
        try await index.indexSearchableItems(items)
        #if DEBUG
          if ProcessInfo.processInfo.environment["ANKIEL_DEBUG_RECENTS"] == "1" { print("spotlight: indexed \(items.count)") }
        #endif
      } catch {
        #if DEBUG
          print("spotlight: indexing failed: \(error)")
        #endif
      }
    }
  }

  nonisolated private static func item(_ entry: RecentThreads.Entry) -> CSSearchableItem {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = entry.title
    attributes.contentDescription = entry.environmentLabel
    return CSSearchableItem(
      uniqueIdentifier: AppEntry.thread(entry.ref).url().absoluteString, domainIdentifier: entry.environmentId,
      attributeSet: attributes)
  }

  /// The entry a quick action stands for.
  static func entry(_ item: UIApplicationShortcutItem) -> AppEntry? {
    switch QuickAction(rawValue: item.type) {
    case .newThread: .newThread()
    case .search: .search()
    case .thread: (item.userInfo?["url"] as? String).flatMap(URL.init(string:)).flatMap(AppEntry.parse)
    case nil: nil
    }
  }
}

/// Feeds the publisher from the app: opened threads, and saved computers or shells changing.
/// Spotlight taps arrive here as a user activity.
struct ShortcutSync: ViewModifier {
  @Environment(AppModel.self) private var model

  func body(content: Content) -> some View {
    content
      .onChange(of: model.navigator.stack.last) { _, ref in
        if let ref, !ThreadDebug.isFixture(ref) { ShortcutPublisher.shared.record(ref, model: model) }
      }
      .onChange(of: syncKey, initial: true) { _, _ in
        if model.registry.isLoaded { ShortcutPublisher.shared.sync(model) }
      }
      #if DEBUG
        .task {
          VoiceInput.debugAudioSession()
          await ShortcutDebug.run()
        }
      #endif
      .onContinueUserActivity(CSSearchableItemActionType) { activity in
        if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String, let url = URL(string: id),
          let entry = AppEntry.parse(url)
        {
          model.open(entry)
        }
      }
  }

  /// Changes when a computer is added or removed, or a shell's sequence moves.
  private var syncKey: [String] {
    model.registry.environments.map { "\($0.id)|\($0.label)|\($0.shell.snapshot?.snapshotSequence ?? -1)" }
      + [model.registry.isLoaded ? "loaded" : ""]
  }
}

/// Quick actions reach a scene delegate, not SwiftUI: at a cold launch in the connection
/// options, and while running through `performActionFor`.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    if let item = connectionOptions.shortcutItem, let entry = ShortcutPublisher.entry(item) {
      AppEntryInbox.shared.deliver(entry)
    }
  }

  func windowScene(
    _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void
  ) {
    guard let entry = ShortcutPublisher.entry(shortcutItem) else { return completionHandler(false) }
    AppEntryInbox.shared.deliver(entry)
    completionHandler(true)
  }
}

extension AppDelegate {
  func application(
    _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    configuration.delegateClass = QuickActionSceneDelegate.self
    return configuration
  }
}
