import AnkielKit
import UIKit
import UserNotifications

/// Owns the app model so notification callbacks reach it before any scene exists (a button
/// pressed with the app terminated launches it in the background, with no window).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  let model: AppModel = {
    LaunchSignposts.mark("appModelInit")
    defer { LaunchSignposts.mark("appModelReady") }
    return AppModel()
  }()
  lazy var push = PushCoordinator(model: model)

  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LaunchSignposts.mark("didFinishLaunching")
    // Set before launch ends, or a cold-start tap is never delivered.
    UNUserNotificationCenter.current().delegate = self
    push.start()
    LaunchSignposts.mark("pushStarted")
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    push.didRegister(token: deviceToken)
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    push.didFailToRegister()
  }

  // MARK: UNUserNotificationCenterDelegate

  // The completion-handler forms, called back on the main thread: the `async` forms finish off it,
  // and UIKit asserts when the response's completion runs there.

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler(push.presentation(for: AgentAlert(userInfo: notification.request.content.userInfo)))
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    guard let alert = AgentAlert(userInfo: response.notification.request.content.userInfo) else { return completionHandler() }
    let text = (response as? UNTextInputNotificationResponse)?.userText
    if let action = alert.action(identifier: response.actionIdentifier, text: text) {
      // The background time lasts until the completion is called.
      Task { @MainActor in
        await push.answer(action, from: alert)
        completionHandler()
      }
      return
    }
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier || response.actionIdentifier == AgentAlertIDs.reply {
      // A tap, or a Reply sent empty, which only opens the thread.
      push.open(alert)
    }
    completionHandler()
  }
}
