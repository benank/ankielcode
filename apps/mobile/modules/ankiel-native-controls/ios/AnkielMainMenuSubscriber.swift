import ExpoModulesCore
import UIKit

public final class AnkielMainMenuSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AnkielKeyboardCommandCatalog.installMainMenu()
    return true
  }
}
