import XCTest

/// The keyboard commands added for thread navigation, on the canned list. The iPad menu bar
/// itself cannot be opened from a phone simulator.
final class KeyboardCommandUITests: HomeUITestCase {
  override func setUp() async throws {
    launch(["ANKIEL_DEBUG_HOME": "sample"])
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5))
  }

  private var threadMenu: XCUIElement { app.buttons["thread.menu"] }

  /// Command-F stays with the system's Find on iOS 26, so search is Command-K (RN's phone binding).
  func testCommandKFocusesSearch() {
    app.typeKey("1", modifierFlags: .command)
    XCTAssertTrue(threadMenu.waitForExistence(timeout: 5))
    app.typeKey("k", modifierFlags: .command)
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5), "Command-K leaves the thread for the list")
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 3))
    let focused = expectation(for: NSPredicate(format: "hasKeyboardFocus == true"), evaluatedWith: field)
    wait(for: [focused], timeout: 3)
  }

  func testJumpNextAndBack() {
    app.typeKey("1", modifierFlags: .command)
    XCTAssertTrue(threadMenu.waitForExistence(timeout: 5), "Command-1 opens the first thread")
    let title = app.navigationBars.firstMatch.staticTexts.firstMatch
    let first = title.label
    app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [.command, .option])
    let moved = expectation(for: NSPredicate(format: "label != %@", first), evaluatedWith: title)
    wait(for: [moved], timeout: 5)
    app.typeKey("[", modifierFlags: .command)
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5), "Command-[ goes back to the list")
    app.typeKey("2", modifierFlags: .command)
    XCTAssertTrue(threadMenu.waitForExistence(timeout: 5))
    app.typeKey("0", modifierFlags: .command)
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5), "Command-0 goes home")
  }

  /// The thread commands come from the open composer (a focused scene value); Command-L proves
  /// the value arrives. (The test runner may not read the app's pasteboard, so Copy link is untested.)
  func testThreadCommandsReachTheComposer() {
    app.terminate()
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    let field = app.descendants(matching: .any).matching(identifier: "composer.field").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    app.typeKey("l", modifierFlags: .command)
    let focused = expectation(for: NSPredicate(format: "hasKeyboardFocus == true"), evaluatedWith: field)
    wait(for: [focused], timeout: 3)
  }
}
