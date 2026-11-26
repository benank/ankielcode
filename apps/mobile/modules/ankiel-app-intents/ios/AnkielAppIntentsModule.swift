import CoreSpotlight
import ExpoModulesCore
import Foundation

private struct DonatedThread: Codable, Sendable {
  let path: String
  let title: String
}

/// Donates the recent threads JavaScript already shows to on-device Spotlight and to the App
/// Shortcuts thread picker, and hands JavaScript the paths those surfaces open.
public final class AnkielAppIntentsModule: Module {
  private static let spotlightDomain = "threads"

  private var observer: NSObjectProtocol?
  private let indexLock = NSLock()
  private var indexing: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("AnkielAppIntents")
    Events("onPendingPath")

    OnCreate {
      self.observeInbox()
    }

    OnDestroy {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
      }
    }

    Function("takePendingPath") { () -> String? in
      AnkielAppIntentsInbox.take()
    }

    Function("setRecentThreads") { (threads: [[String: String]]) in
      let donated = threads.compactMap { thread -> DonatedThread? in
        guard let path = thread["path"], let title = thread["title"] else { return nil }
        return DonatedThread(path: path, title: title)
      }
      if donated.isEmpty {
        UserDefaults.standard.removeObject(forKey: AnkielAppIntentsInbox.recentThreadsDefaultsKey)
      } else if let data = try? JSONEncoder().encode(donated) {
        UserDefaults.standard.set(data, forKey: AnkielAppIntentsInbox.recentThreadsDefaultsKey)
      }
      self.replaceSpotlightItems(with: donated)
    }
  }

  private func observeInbox() {
    observer = NotificationCenter.default.addObserver(
      forName: AnkielAppIntentsInbox.pendingPathNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent("onPendingPath")
    }
  }

  /// Each replacement deletes the domain and then indexes, after the previous one finishes, so a
  /// late delete can never wipe a newer list.
  private func replaceSpotlightItems(with threads: [DonatedThread]) {
    indexLock.withLock {
      let previous = indexing
      indexing = Task {
        await previous?.value
        let index = CSSearchableIndex.default()
        do {
          try await index.deleteSearchableItems(withDomainIdentifiers: [Self.spotlightDomain])
          guard !threads.isEmpty else { return }
          try await index.indexSearchableItems(threads.map(Self.searchableItem))
        } catch {
          log.warn("AnkielAppIntents: Spotlight update failed: \(error.localizedDescription)")
        }
      }
    }
  }

  private static func searchableItem(_ thread: DonatedThread) -> CSSearchableItem {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = thread.title
    return CSSearchableItem(
      uniqueIdentifier: thread.path,
      domainIdentifier: spotlightDomain,
      attributeSet: attributes
    )
  }
}
