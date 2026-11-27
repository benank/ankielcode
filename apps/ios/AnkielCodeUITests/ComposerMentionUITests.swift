import XCTest

/// `@` mentions over a fixture thread with the fake composer: its `@` search answers from a
/// made-up workspace (`MentionDebug`), so no server is needed.
final class ComposerMentionUITests: HomeUITestCase {
  var field: XCUIElement { app.textViews["composer.field"] }
  var send: XCUIElement { app.buttons["composer.send"] }

  func open() {
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
  }

  func testPickingAMentionInsertsAChipThatDeletesAsOneAndSends() {
    open()
    field.typeText("Compare @tide")
    let suggestion = app.buttons["composer.suggestion.TideChart.swift"]
    XCTAssertTrue(suggestion.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["composer.suggestion.TideTable.swift"].exists)
    shot("mention-suggestions")
    suggestion.tap()
    XCTAssertEqual(field.value as? String, "Compare [TideChart.swift](src/tides/TideChart.swift) ")
    XCTAssertFalse(suggestion.exists, "the list closes after a pick")
    field.typeText("now")
    shot("mention-chip")
    // "now", the space, then the chip in one press.
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
    XCTAssertEqual(field.value as? String, "Compare ")
    field.typeText("@readme")
    let readme = app.buttons["composer.suggestion.README.md"]
    XCTAssertTrue(readme.waitForExistence(timeout: 5))
    readme.tap()
    XCTAssertEqual(field.value as? String, "Compare [README.md](README.md) ")
    send.tap()
    // The sent bubble shows the file link by its name.
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'README.md'")).firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String ?? "", "Message")
    shot("mention-sent")
  }

  func testTheKeyboardMovesThroughAndPicksSuggestions() {
    open()
    field.typeText("@")
    XCTAssertTrue(app.buttons["composer.suggestion.README.md"].waitForExistence(timeout: 5))
    // README.md, src, then TideChart.swift.
    field.typeKey(.downArrow, modifierFlags: [])
    field.typeKey(.downArrow, modifierFlags: [])
    field.typeKey(.upArrow, modifierFlags: [])
    field.typeKey(.downArrow, modifierFlags: [])
    shot("mention-keyboard")
    // Return picks (typed as text: the simulator's synthesized Return key event never reaches the field).
    field.typeText("\n")
    XCTAssertEqual(field.value as? String, "[TideChart.swift](src/tides/TideChart.swift) ")
    field.typeText("@harbor")
    XCTAssertTrue(app.buttons["composer.suggestion.Buoy readings.md"].waitForExistence(timeout: 5))
    // A space ends the word, which closes the list and leaves the text as typed.
    field.typeText(" ")
    XCTAssertTrue(app.buttons["composer.suggestion.Buoy readings.md"].waitForNonExistence(timeout: 2))
    XCTAssertEqual(field.value as? String, "[TideChart.swift](src/tides/TideChart.swift) @harbor ")
  }
}
