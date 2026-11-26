import Foundation

/// Paths that App Shortcuts and Spotlight taps ask the app to open. They usually arrive before
/// JavaScript runs, so the latest one waits here until JavaScript takes it.
enum AnkielAppIntentsInbox {
  // Shared with app-target/AnkielAppShortcuts.swift, which cannot import this pod.
  static let recentThreadsDefaultsKey = "AnkielAppIntents.recentThreads"
  static let openPathNotification = Notification.Name("AnkielAppIntents.openPath")
  static let pendingPathNotification = Notification.Name("AnkielAppIntents.pendingPath")

  private static let lock = NSLock()
  nonisolated(unsafe) private static var pendingPath: String?

  static func deliver(_ path: String) {
    lock.withLock { pendingPath = path }
    NotificationCenter.default.post(name: pendingPathNotification, object: nil)
  }

  static func take() -> String? {
    lock.withLock {
      defer { pendingPath = nil }
      return pendingPath
    }
  }
}
