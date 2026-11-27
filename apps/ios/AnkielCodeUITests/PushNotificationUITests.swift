import XCTest

/// Push alerts on the simulator, through SpringBoard. These need a host driving
/// `xcrun simctl push` while they wait (payloads in `apps/ios/scripts/push-samples`, see the
/// README's "Push notifications" section), so they skip unless `PUSH_UI_TESTS=1` is passed as
/// `TEST_RUNNER_PUSH_UI_TESTS=1`.
final class PushNotificationUITests: HomeUITestCase {
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  override func setUp() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["PUSH_UI_TESTS"] == "1", "needs a host sending simctl pushes")
  }

  /// A banner (or expanded alert) whose text contains `text`.
  func banner(_ text: String) -> XCUIElement {
    springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  /// Taps iOS's "Allow" on the permission prompt when it shows.
  func allowNotifications() {
    let allow = springboard.buttons["Allow"]
    if allow.waitForExistence(timeout: 5) { allow.tap() }
  }

  /// Opens the banner's actions (touch and hold) and presses one.
  func press(_ action: String, on text: String) {
    let alert = banner(text)
    XCTAssertTrue(alert.waitForExistence(timeout: 120), "a banner with \(text)")
    alert.press(forDuration: 1.2)
    let button = springboard.descendants(matching: .any).matching(NSPredicate(format: "label == %@", action)).firstMatch
    let shown = button.waitForExistence(timeout: 5)
    shot("push-actions-\(action.lowercased())")
    XCTAssertTrue(shown, "the \(action) button")
    button.tap()
  }

  func testTurningOnAsksForPermissionAndRegisters() {
    launch(["ANKIEL_DEBUG_ROUTE": "settings-notifications"])
    let toggle = app.switches["notifications.enabled"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    if toggle.value as? String != "1" { toggle.switches.firstMatch.tap() }
    allowNotifications()
    XCTAssertTrue(app.switches["notifications.kind.approval"].waitForExistence(timeout: 10), "the alert kinds show once allowed")
    XCTAssertTrue(app.staticTexts["Relay not set up on this computer"].waitForExistence(timeout: 15), "the dev server has no relay")
    shot("push-settings-on")
  }

  /// The host sends an approval alert for a staged request while the app is in the background.
  func testApproveWarm() {
    launch()
    XCUIDevice.shared.press(.home)
    press("Approve", on: "Needs your approval")
    // Background time to connect and send, or to give up and say so.
    if springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'send your answer'")).firstMatch
      .waitForExistence(timeout: 35)
    {
      shot("push-unsent")
    }
  }

  /// The same with the app terminated: iOS launches it in the background, with no scene.
  func testApproveCold() {
    launch()
    app.terminate()
    press("Approve", on: "Needs your approval")
    sleep(25)
  }

  func testDenyWarm() {
    launch()
    XCUIDevice.shared.press(.home)
    press("Deny", on: "Needs your approval")
    sleep(20)
  }

  /// A reply typed into the alert.
  func testReply() {
    launch()
    XCUIDevice.shared.press(.home)
    // With one text action, touch and hold opens the reply field directly.
    let alert = banner("Waiting for your input")
    XCTAssertTrue(alert.waitForExistence(timeout: 120))
    alert.press(forDuration: 1.2)
    // The field takes focus with the keyboard up.
    let send = springboard.descendants(matching: .any).matching(NSPredicate(format: "label == 'Send'")).firstMatch
    XCTAssertTrue(send.waitForExistence(timeout: 5), "the reply field's Send")
    springboard.typeText("Use the harbor readings")
    shot("push-reply-typed")
    send.tap()
    sleep(20)
  }

  /// Tapping a banner opens its thread.
  func testTapOpensThread() {
    launch()
    XCUIDevice.shared.press(.home)
    let alert = banner("Finished")
    XCTAssertTrue(alert.waitForExistence(timeout: 120))
    shot("push-banner-home")
    alert.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    let menu = app.descendants(matching: .any)["thread.menu"].firstMatch
    let opened = menu.waitForExistence(timeout: 15)
    shot("push-tap-opened")
    XCTAssertTrue(opened, "the alert's thread is open")
  }

  /// Tapping a banner with the app terminated launches it on that thread.
  func testTapOpensThreadCold() {
    launch()
    app.terminate()
    let alert = banner("Finished")
    XCTAssertTrue(alert.waitForExistence(timeout: 120))
    alert.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    let opened = app.descendants(matching: .any)["thread.menu"].firstMatch.waitForExistence(timeout: 20)
    shot("push-tap-cold")
    XCTAssertTrue(opened, "the alert's thread is open")
  }

  /// Turning push off hides the kinds (and unregisters from each connected computer).
  func testTurningOff() {
    launch(["ANKIEL_DEBUG_ROUTE": "settings-notifications"])
    let toggle = app.switches["notifications.enabled"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    if toggle.value as? String == "1" { toggle.switches.firstMatch.tap() }
    XCTAssertTrue(app.switches["notifications.kind.approval"].waitForNonExistence(timeout: 5))
    sleep(3)
    shot("push-settings-off")
  }

  /// With a thread open (`PUSH_THREAD_URL`), its own alert stays quiet; another thread's alert
  /// shows. The host sends "Finished" for the open thread, then "Failed" for another.
  func testQuietForOpenThread() {
    launch(["ANKIEL_OPEN_URL": ProcessInfo.processInfo.environment["PUSH_THREAD_URL"] ?? ""])
    XCTAssertFalse(banner("Finished").waitForExistence(timeout: 40), "the open thread's alert stays quiet")
    XCTAssertTrue(banner("Failed").waitForExistence(timeout: 60), "another thread's alert shows")
    shot("push-banner-foreground")
  }
}
