import CoreSpotlight
import ExpoModulesCore
import UIKit

public final class AnkielAppIntentsSubscriber: ExpoAppDelegateSubscriber {
  private var observer: NSObjectProtocol?

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    observer = NotificationCenter.default.addObserver(
      forName: AnkielAppIntentsInbox.openPathNotification,
      object: nil,
      queue: nil
    ) { notification in
      if let path = notification.userInfo?["path"] as? String {
        AnkielAppIntentsInbox.deliver(path)
      }
    }
    return true
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    // Expo waits for every responding subscriber before it calls the system's handler.
    defer { restorationHandler(nil) }
    guard userActivity.activityType == CSSearchableItemActionType,
      let path = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    else {
      return false
    }
    AnkielAppIntentsInbox.deliver(path)
    return true
  }
}
