import XCTest

/// `/` and `$` over a fixture thread with the fake composer, whose Claude lists `/review`,
/// `/compact`, `/clear`, `/usage-limits` and a `tide-tables` skill (`DebugCatalog`).
final class ComposerSlashCommandUITests: HomeUITestCase {
  var field: XCUIElement { app.textViews["composer.field"] }

  func open() {
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(field.waitForExistence(timeout: 8))
    field.tap()
  }

  func suggestion(_ label: String) -> XCUIElement { app.buttons["composer.suggestion.\(label)"] }

  func testSlashListsAnkielAndProviderCommandsAndInsertsOne() {
    open()
    field.typeText("/")
    XCTAssertTrue(suggestion("/model").waitForExistence(timeout: 5))
    XCTAssertTrue(suggestion("/clear").exists)
    XCTAssertTrue(suggestion("/review").exists)
    XCTAssertTrue(suggestion("/compact").exists, "the thread has a conversation")
    XCTAssertTrue(suggestion("skill:tide-tables").exists)
    shot("slash-list")
    field.typeText("rev")
    XCTAssertTrue(suggestion("/clear").waitForNonExistence(timeout: 2))
    suggestion("/review").tap()
    XCTAssertEqual(field.value as? String, "/review ")
  }

  func testModelCommandOpensThePicker() {
    open()
    field.typeText("/mo")
    XCTAssertTrue(suggestion("/model").waitForExistence(timeout: 5))
    suggestion("/model").tap()
    XCTAssertTrue(app.buttons["modelPicker.done"].waitForExistence(timeout: 5))
    app.buttons["modelPicker.done"].tap()
    XCTAssertEqual(field.value as? String ?? "", "Message", "the typed command is cleared")
  }

  func testClearArmsAFreshSessionUntilTheNextMessage() {
    open()
    field.typeText("/cl")
    XCTAssertTrue(suggestion("/clear").waitForExistence(timeout: 5))
    suggestion("/clear").tap()
    let notice = app.descendants(matching: .any)["composer.freshSession"]
    XCTAssertTrue(notice.waitForExistence(timeout: 3))
    shot("slash-fresh-session")
    app.buttons["composer.freshSession.keep"].tap()
    XCTAssertTrue(notice.waitForNonExistence(timeout: 3), "keeping the session disarms it")
    // Typed as the whole message, /clear arms it too, and the next send carries it away.
    field.typeText("/clear")
    XCTAssertTrue(suggestion("/clear").waitForExistence(timeout: 2))
    app.buttons["composer.send"].tap()
    XCTAssertTrue(notice.waitForExistence(timeout: 3))
    field.typeText("Start over from the spec")
    app.buttons["composer.send"].tap()
    XCTAssertTrue(notice.waitForNonExistence(timeout: 3))
    XCTAssertTrue(app.staticTexts["Start over from the spec"].waitForExistence(timeout: 5))
  }

  func testUsageLimitsOpensUsageAndSkillsComplete() {
    open()
    field.typeText("/usage")
    XCTAssertTrue(suggestion("/usage-limits").waitForExistence(timeout: 5))
    suggestion("/usage-limits").tap()
    XCTAssertTrue(app.buttons["usage.done"].waitForExistence(timeout: 5))
    app.buttons["usage.done"].tap()
    XCTAssertTrue(app.buttons["usage.done"].waitForNonExistence(timeout: 3))
    field.tap()
    field.typeText("Run $tide")
    XCTAssertTrue(suggestion("tide-tables").waitForExistence(timeout: 5))
    suggestion("tide-tables").tap()
    XCTAssertEqual(field.value as? String, "Run $tide-tables ")
    shot("skill-chip")
  }
}
