import XCTest

/// Hardware keyboard shortcuts on the list. Not covered: Command-Return in the composer and Escape
/// in sheets, because on the simulator `typeKey` delivers neither Return nor Escape (a plain Return
/// does not reach a text field either).
final class KeyboardShortcutUITests: HomeUITestCase {
  override func setUp() async throws {
    launch(["ANKIEL_DEBUG_HOME": "sample"])
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5))
  }

  func testCommandNOpensNewThread() {
    app.typeKey("n", modifierFlags: .command)
    XCTAssertTrue(app.navigationBars["New thread"].waitForExistence(timeout: 3))
  }
}
