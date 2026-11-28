import XCTest

/// System entry points. Quick actions go through Springboard (long-press the icon); intents run
/// their own `perform()` at a cold launch through `ANKIEL_DEBUG_INTENT`, since Siri and the
/// Shortcuts app cannot be driven here. Needs the dev server (the thread quick action opens a
/// real thread); restores the new-thread draft it fills.
final class ShortcutUITests: HomeUITestCase {
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
  }

  private func quickAction(_ title: String) throws {
    XCUIDevice.shared.press(.home)
    // The React Native app shares the name "Ankiel Code" when both are installed, and Springboard
    // gives icons no bundle id, so use the icon whose menu offers this app's quick action.
    let icons = springboard.icons.matching(identifier: "Ankiel Code")
    guard icons.firstMatch.waitForExistence(timeout: 5) else { throw XCTSkip("The app icon is not on a Home Screen page.") }
    let action = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    for index in 0..<icons.count {
      let icon = icons.element(boundBy: index)
      for _ in 0..<3 where !icon.isHittable {
        springboard.swipeLeft()
      }
      for _ in 0..<3 where !icon.isHittable {
        springboard.swipeRight()
      }
      guard icon.isHittable else { continue }
      icon.press(forDuration: 1.3)
      if action.waitForExistence(timeout: 4) {
        shot("quick-actions")
        action.tap()
        return
      }
      XCUIDevice.shared.press(.home)
    }
    XCTFail("quick action \(title)")
  }

  func testSearchAndRecentThreadQuickActions() throws {
    launch(["ANKIEL_DEBUG_ROUTE": "thread"])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15), "a live thread opens")
    let title = app.navigationBars.firstMatch.staticTexts.firstMatch.label

    try quickAction("Search")
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: field)
    XCTAssertEqual(XCTWaiter.wait(for: [focused], timeout: 5), .completed, "search is focused")

    try quickAction(title)
    XCTAssertTrue(menu.waitForExistence(timeout: 8), "the recent thread opens")
  }

  func testNewThreadIntentFromColdLaunchKeepsTheDraft() {
    let prompt = "Check the harbor buoy readings"
    launch(["ANKIEL_DEBUG_INTENT": "new:\(prompt)"])
    let field = app.textViews["composer.field"].exists ? app.textViews["composer.field"] : app.textFields["composer.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "the new-thread sheet opens")
    let value = field.value as? String ?? ""
    XCTAssertTrue(value.contains(prompt), "the prompt is in the draft: \(value)")
    shot("intent-new-thread")
    // Put the draft back.
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
  }

  func testSearchIntent() {
    launch(["ANKIEL_DEBUG_INTENT": "search:probe"])
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "probe")
  }

  /// Spotlight lists the recent thread, and tapping the result opens it.
  func testSpotlightResultOpensThread() throws {
    launch(["ANKIEL_DEBUG_ROUTE": "thread"])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    let title = app.navigationBars.firstMatch.staticTexts.firstMatch.label
    XCUIDevice.shared.press(.home)
    let start = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
    start.press(forDuration: 0.05, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
    let spotlight = XCUIApplication(bundleIdentifier: "com.apple.Spotlight")
    guard spotlight.wait(for: .runningForeground, timeout: 5) else {
      shot("spotlight-closed")
      throw XCTSkip("Spotlight did not open.")
    }
    spotlight.typeText(title)
    // Cells only: the search field and web suggestions carry the title too.
    let result = spotlight.cells.matching(NSPredicate(
      format: "label CONTAINS %@ AND NOT identifier CONTAINS 'WebSuggestion' AND NOT label CONTAINS 'Google'", title)).firstMatch
    guard result.waitForExistence(timeout: 10) else {
      shot("spotlight-missing")
      throw XCTSkip("Spotlight has not indexed the thread yet.")
    }
    shot("spotlight")
    result.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
    XCTAssertTrue(menu.waitForExistence(timeout: 8), "the thread opens")
  }

  /// A quick action that launches the app (the scene delegate's connection options).
  func testSearchQuickActionFromColdLaunch() throws {
    launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
    XCUIDevice.shared.press(.home)
    app.terminate()
    try quickAction("Search")
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    let focused = expectation(for: NSPredicate(format: "hasKeyboardFocus == true"), evaluatedWith: field)
    wait(for: [focused], timeout: 10)
  }
}
