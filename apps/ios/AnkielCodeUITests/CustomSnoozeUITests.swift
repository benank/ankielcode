import XCTest

/// "Custom…" under a row's Snooze, over the canned list (`ANKIEL_DEBUG_HOME=sample`). Canned rows
/// are on no server, so the snooze itself fails with the list's alert: that proves it was sent.
final class CustomSnoozeUITests: HomeUITestCase {
  func testCustomSnoozeAsksForATimeOrADurationAndSnoozes() {
    launch(["ANKIEL_DEBUG_HOME": "sample"])
    let target = row("done")
    XCTAssertTrue(target.waitForExistence(timeout: 8))
    target.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 3))
    app.buttons["Snooze"].tap()
    // Menu items expose their title, not an identifier.
    let custom = app.buttons["Custom…"]
    XCTAssertTrue(custom.waitForExistence(timeout: 3))
    custom.tap()
    XCTAssertTrue(app.navigationBars["Custom snooze"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.descendants(matching: .any)["customSnooze.date"].exists)
    shot("custom-snooze-date")
    app.segmentedControls.buttons["Duration"].tap()
    XCTAssertTrue(app.pickerWheels.firstMatch.waitForExistence(timeout: 2))
    shot("custom-snooze-duration")
    app.buttons["customSnooze.confirm"].tap()
    XCTAssertTrue(app.navigationBars["Custom snooze"].waitForNonExistence(timeout: 3))
    XCTAssertTrue(app.alerts["Could not snooze thread"].waitForExistence(timeout: 5), "the snooze went to the thread's computer")
    app.alerts.buttons.firstMatch.tap()
  }
}
